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
    
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        try {
            serviceAccount = require('./serviceAccountKey.json');
        } catch (err) {
            console.warn("Local serviceAccountKey.json not found.");
        }
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // আপনার ডাটাবেস লিংক
            databaseURL: process.env.FIREBASE_DATABASE_URL || "https://roktobij-4210b-default-rtdb.firebaseio.com"
        });
        console.log("Firebase Admin SDK initialized.");
    } else {
        console.error("Firebase credentials not found!");
    }

} catch (e) {
    console.error("Failed to initialize Firebase Admin SDK:", e.message);
}

const db = admin.apps.length ? admin.database() : null;

// কনফিগারেশন
const REFERRAL_BONUS = 100; 
const GAME_REWARD = 10;     

// ==========================================
// 🛠️ সাহায্যকারী ফাংশন: হিস্ট্রি সেভ করা
// ==========================================
async function addHistory(userId, amount, method, type, status, txnId = "") {
    if (!db) return;
    // ✅ ফিক্স: Backtick আছে
    const historyRef = db.ref(`walletHistory/${userId}`);
    const newHistoryRef = historyRef.push();
    
    await newHistoryRef.set({
        amount: amount,
        id: newHistoryRef.key,
        method: method,          
        status: status,          
        timestamp: admin.database.ServerValue.TIMESTAMP,
        transactionId: txnId,
        type: type,              
        userId: userId
    });
}

// ==========================================
// 🚀 2. API: টুর্নামেন্ট লিস্ট
// ==========================================
app.get('/api/tournaments', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    try {
        const snapshot = await db.ref('tournaments').once('value');
        const tournaments = [];

        snapshot.forEach((child) => {
            const data = child.val();
            
            tournaments.push({
                id: child.key,
                title: data.title || data.gameName || "Tournament Match", 
                prize: data.prizePool || data.prize || "0",        
                entryFee: parseInt(data.entryFee || 0),
                status: data.status || "Upcoming",
                map: data.map || "",
                schedule: data.schedule || ""
            });
        });

        res.json({ success: true, data: tournaments.reverse() });

    } catch (error) {
        console.error("Fetch Tournaments Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 🚀 3. API: গেম রিওয়ার্ড ক্লেইম করা (FIXED)
// ==========================================
app.post('/api/claim-reward', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });
    
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ success: false, message: "User ID missing!" });

    try {
        // ✅ ফিক্স: Backtick মিসিং ছিল, এখন ঠিক করা হয়েছে
        await db.ref(users/${uid}/wallet).update({
            greenDiamondBalance: admin.database.ServerValue.increment(GAME_REWARD)
        });

        await addHistory(uid, GAME_REWARD, "Game Zone Win", "Reward", "approved");

        res.json({ success: true, message: "Reward added!" });
    } catch (error) {
        console.error("Game Reward Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 🚀 4. API: রেফারেল কোড রিডিম করা (FIXED)
// ==========================================
app.post('/api/redeem-referral', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const { code, userId } = req.body;
    if (!userId || !code) return res.status(400).json({ message: "Missing data." });

    try {
        // ✅ ফিক্স: Backtick আছে
        const newUserRef = db.ref(users/${userId});
        const userSnap = await newUserRef.once("value");
        const userData = userSnap.val();

        if (!userData) return res.status(404).json({ message: "User not found." });
        if (userData.referredBy) return res.status(409).json({ message: "Already referred." });
        if (userData.referCode === code) return res.status(400).json({ message: "Cannot use own code." });

        const query = db.ref("users").orderByChild("referCode").equalTo(code);
        const referrerSnap = await query.once("value");

        if (!referrerSnap.exists()) return res.status(404).json({ message: "Invalid code." });

        const referrerId = Object.keys(referrerSnap.val())[0];

        await newUserRef.child('wallet').update({
            greenDiamondBalance: admin.database.ServerValue.increment(REFERRAL_BONUS)
        });
        await newUserRef.update({ referredBy: referrerId });

        // ✅ ফিক্স: Backtick আছে
        await db.ref(users/${referrerId}/wallet).update({
            greenDiamondBalance: admin.database.ServerValue.increment(REFERRAL_BONUS)
        });

        await addHistory(userId, REFERRAL_BONUS, "Referral Bonus (Joined)", "Reward", "approved", referrerId);
        await addHistory(referrerId, REFERRAL_BONUS, "Referral Bonus (Invite)", "Reward", "approved", userId);

        res.json({ success: true, message: "Referral successful!" });

    } catch (error) {
        console.error("Referral Error:", error);
        res.status(500).json({ message: "Server Error" });
    }
});

// ==========================================
// 🚀 5. API: টুর্নামেন্টে জয়েন করা
// ==========================================
app.post('/api/join-tournament', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const { userId, tournamentId } = req.body;
    if (!userId || !tournamentId) return res.status(400).json({ success: false, message: "Missing Data" });

    try {
        // ✅ ফিক্স: Backtick আছে
        const tournamentRef = db.ref(tournaments/${tournamentId});
        const tourSnap = await tournamentRef.once('value');

        if (!tourSnap.exists()) return res.status(404).json({ success: false, message: "Tournament not found" });

        const tourData = tourSnap.val();
        const entryFee = parseInt(tourData.entryFee || 0);

        if (tourData.participants && tourData.participants[userId]) {
            return res.status(400).json({ success: false, message: "Already joined!" });
        }

        // ✅ ফিক্স: Backtick আছে
        const walletRef = db.ref(users/${userId}/wallet/greenDiamondBalance);
        const balSnap = await walletRef.once('value');
        const balance = balSnap.val() || 0;

        if (balance < entryFee) return res.status(400).json({ success: false, message: "Insufficient Balance" });

        await walletRef.transaction((current) => {
            return (current || 0) - entryFee;
        });
        
        await tournamentRef.child('participants').child(userId).set({
            joinedAt: admin.database.ServerValue.TIMESTAMP
        });

        await addHistory(userId, entryFee, "Tournament Entry Fee", "Debit", "approved", tournamentId);

        res.json({ success: true, message: "Joined successfully!" });

    } catch (error) {
        console.error("Join Tournament Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(Server is running on port ${PORT});
});
