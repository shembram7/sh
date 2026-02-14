const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ==========================================
// 🔥 1. Firebase Admin SDK কনফিগারেশন
// ==========================================
try {
    let serviceAccount;
    
    // Render-এ Environment Variable ব্যবহার করা হচ্ছে
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        // লোকাল টেস্টিংয়ের জন্য (যদি ফাইল থাকে)
        try {
            serviceAccount = require('./serviceAccountKey.json');
        } catch (err) {
            console.warn("Local serviceAccountKey.json not found. Ensure FIREBASE_CREDENTIALS is set in Render.");
        }
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // ⚠️ আপনার স্ক্রিনশট অনুযায়ী সঠিক ডাটাবেস লিংক
            databaseURL: process.env.FIREBASE_DATABASE_URL || "https://roktobij-4210b-default-rtdb.firebaseio.com"
        });
        console.log("Firebase Admin SDK initialized successfully.");
    } else {
        console.error("Firebase credentials not found! Server cannot connect to DB.");
    }

} catch (e) {
    console.error("Failed to initialize Firebase Admin SDK:", e.message);
}

// ফায়ারবেস ইনিশিয়ালাইজ না হলে ক্র্যাশ ঠেকানোর জন্য চেক
const db = admin.apps.length ? admin.database() : null;

// কনফিগারেশন
const REFERRAL_BONUS = 100; // রেফারেল বোনাস
const GAME_REWARD = 10;     // গেম রিওয়ার্ড

// ==========================================
// 🛠️ সাহায্যকারী ফাংশন: হিস্ট্রি সেভ করা
// ==========================================
async function addHistory(userId, amount, method, type, status, txnId = "") {
    if (!db) return;
    const historyRef = db.ref(walletHistory/${userId});
    const newHistoryRef = historyRef.push();
    
    await newHistoryRef.set({
        amount: amount,
        id: newHistoryRef.key,
        method: method,          // অ্যাপের সাবটাইটেল (যেমন: Spin Win, Game Zone)
        status: status,          // approved
        timestamp: admin.database.ServerValue.TIMESTAMP,
        transactionId: txnId,
        type: type,              // 'Reward' (Green) or 'Debit' (Red)
        userId: userId
    });
}

// ==========================================
// 🚀 2. API: টুর্নামেন্ট লিস্ট (FIXED for your DB)
// ==========================================
app.get('/api/tournaments', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    try {
        const snapshot = await db.ref('tournaments').once('value');
        const tournaments = [];

        snapshot.forEach((child) => {
            const data = child.val();
            
            // ⚠️ আপনার ডাটাবেস অনুযায়ী ফিল্ড ম্যাপ করা হলো
            tournaments.push({
                id: child.key,
                // title না থাকলে gameName দেখাবে
                title: data.title || data.gameName || "Tournament Match", 
                // prize না থাকলে prizePool দেখাবে
                prize: data.prizePool || data.prize || "0",        
                entryFee: parseInt(data.entryFee || 0),
                status: data.status || "Upcoming",
                map: data.map || "",
                schedule: data.schedule || ""
            });
        });

        // নতুন টুর্নামেন্ট আগে দেখাবে
        res.json({ success: true, data: tournaments.reverse() });

    } catch (error) {
        console.error("Fetch Tournaments Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 🚀 3. API: গেম রিওয়ার্ড ক্লেইম করা
// ==========================================
app.post('/api/claim-reward', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });
    
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ success: false, message: "User ID missing!" });

    try {
        // ব্যালেন্স আপডেট
        await db.ref(users/${uid}/wallet).update({
            greenDiamondBalance: admin.database.ServerValue.increment(GAME_REWARD)
        });

        // হিস্ট্রি সেভ (অ্যাপের ফরম্যাট অনুযায়ী)
        await addHistory(uid, GAME_REWARD, "Game Zone Win", "Reward", "approved");

        res.json({ success: true, message: "Reward added!" });
    } catch (error) {
        console.error("Game Reward Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 🚀 4. API: রেফারেল কোড রিডিম করা
// ==========================================
app.post('/api/redeem-referral', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const { code, userId } = req.body;
    if (!userId || !code) return res.status(400).json({ message: "Missing data." });

    try {
        const newUserRef = db.ref(users/${userId});
        const userSnap = await newUserRef.once("value");
        const userData = userSnap.val();

        if (!userData) return res.status(404).json({ message: "User not found." });
        if (userData.referredBy) return res.status(409).json({ message: "Already referred." });
        if (userData.referCode === code) return res.status(400).json({ message: "Cannot use own code." });

        // রেফারার খোঁজা
        const query = db.ref("users").orderByChild("referCode").equalTo(code);
        const referrerSnap = await query.once("value");

        if (!referrerSnap.exists()) return res.status(404).json({ message: "Invalid code." });

        const referrerId = Object.keys(referrerSnap.val())[0];

        // 1. নতুন ইউজারের ব্যালেন্স + referredBy আপডেট
        await newUserRef.child('wallet').update({
            greenDiamondBalance: admin.database.ServerValue.increment(REFERRAL_BONUS)
        });
        await newUserRef.update({ referredBy: referrerId });

        // 2. রেফারারের ব্যালেন্স আপডেট
        await db.ref(users/${referrerId}/wallet).update({
            greenDiamondBalance: admin.database.ServerValue.increment(REFERRAL_BONUS)
        });

        // 3. হিস্ট্রি সেভ (উভয়ের জন্য)
        await addHistory(userId, REFERRAL_BONUS, "Referral Bonus (Joined)", "Reward", "approved", referrerId);
        await addHistory(referrerId, REFERRAL_BONUS, "Referral Bonus (Invite)", "Reward", "approved", userId);

        res.json({ success: true, message: "Referral successful!" });

    } catch (error) {
        console.error("Referral Error:", error);
        res.status(500).json({ message: "Server Error" });
    }
});

// ==========================================
// 🚀 5. API: টুর্নামেন্টে জয়েন করা (Balance Cut)
// ==========================================
app.post('/api/join-tournament', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const { userId, tournamentId } = req.body;
    if (!userId || !tournamentId) return res.status(400).json({ success: false, message: "Missing Data" });

    try {
        const tournamentRef = db.ref(tournaments/${tournamentId});
        const tourSnap = await tournamentRef.once('value');

        if (!tourSnap.exists()) return res.status(404).json({ success: false, message: "Tournament not found" });

        const tourData = tourSnap.val();
        const entryFee = parseInt(tourData.entryFee || 0);

        // ইউজার চেক
        if (tourData.participants && tourData.participants[userId]) {
            return res.status(400).json({ success: false, message: "Already joined!" });
        }

        // ব্যালেন্স চেক
        const walletRef = db.ref(users/${userId}/wallet/greenDiamondBalance);
        const balSnap = await walletRef.once('value');
        const balance = balSnap.val() || 0;

        if (balance < entryFee) return res.status(400).json({ success: false, message: "Insufficient Balance" });

        // ব্যালেন্স কাটা এবং জয়েন করানো (Transaction দিয়ে নিরাপদ আপডেট)
        await walletRef.transaction((current) => {
            return (current || 0) - entryFee;
        });
        
        // টুর্নামেন্টে জয়েন করানো
        await tournamentRef.child('participants').child(userId).set({
            joinedAt: admin.database.ServerValue.TIMESTAMP
        });

        // হিস্ট্রি সেভ (Debit)
        await addHistory(userId, entryFee, "Tournament Entry Fee", "Debit", "approved", tournamentId);

        res.json({ success: true, message: "Joined successfully!" });

    } catch (error) {
        console.error("Join Tournament Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// সার্ভার চালু করা
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(Server is running on port ${PORT});
});
