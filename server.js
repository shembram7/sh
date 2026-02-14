const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin SDK কনফিগারেশন
// ---------------------------------------------------
try {
    let serviceAccount;
    // Render-এ Environment Variable ব্যবহার করা হচ্ছে
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        // লোকাল টেস্টিংয়ের জন্য
        serviceAccount = require('./serviceAccountKey.json');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // ডাটাবেস URL Environment Variable অথবা সরাসরি স্ট্রিং
        databaseURL: process.env.FIREBASE_DATABASE_URL || "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com"
    });

} catch (e) {
    console.error("Failed to initialize Firebase Admin SDK:", e.message);
    process.exit(1); // সার্ভার বন্ধ করে দেবে যদি ফায়ারবেস কানেক্ট না হয়
}

const db = admin.database();

// কনফিগারেশন
const REFERRAL_BONUS = 100; // রেফারেল বোনাস
const GAME_REWARD = 10;     // গেম রিওয়ার্ড

// ==========================================
// 🛠️ সাহায্যকারী ফাংশন: হিস্ট্রি সেভ করা
// ==========================================
async function addHistory(userId, amount, method, type, status, txnId = "") {
    const historyRef = db.ref(`walletHistory/${userId}`);
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
// 🚀 1. API: গেম রিওয়ার্ড ক্লেইম করা
// ==========================================
app.post('/api/claim-reward', async (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ success: false, message: "User ID missing!" });

    try {
        // ব্যালেন্স আপডেট
        await db.ref(`users/${uid}/wallet`).update({
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
// 🚀 2. API: রেফারেল কোড রিডিম করা
// ==========================================
app.post('/api/redeem-referral', async (req, res) => {
    const { code, userId } = req.body;
    if (!userId || !code) return res.status(400).json({ message: "Missing data." });

    try {
        const newUserRef = db.ref(`users/${userId}`);
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
        await db.ref(`users/${referrerId}/wallet`).update({
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
// 🚀 3. API: টুর্নামেন্ট লিস্ট পাওয়া
// ==========================================
app.get('/api/tournaments', async (req, res) => {
    try {
        const snapshot = await db.ref('tournaments').once('value');
        const tournaments = [];

        snapshot.forEach((child) => {
            const data = child.val();
            // ডাটা ফিল্টার করে পাঠানো
            tournaments.push({
                id: child.key,
                title: data.title || "Match",
                prize: data.prize || "0",
                entryFee: parseInt(data.entryFee || 0),
                status: data.status || "open"
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
// 🚀 4. API: টুর্নামেন্টে জয়েন করা (Balance Cut)
// ==========================================
app.post('/api/join-tournament', async (req, res) => {
    const { userId, tournamentId } = req.body;
    if (!userId || !tournamentId) return res.status(400).json({ success: false, message: "Missing Data" });

    try {
        const tournamentRef = db.ref(`tournaments/${tournamentId}`);
        const tourSnap = await tournamentRef.once('value');

        if (!tourSnap.exists()) return res.status(404).json({ success: false, message: "Tournament not found" });

        const tourData = tourSnap.val();
        const entryFee = parseInt(tourData.entryFee || 0);

        // ইউজার চেক
        if (tourData.participants && tourData.participants[userId]) {
            return res.status(400).json({ success: false, message: "Already joined!" });
        }

        // ব্যালেন্স চেক
        const walletRef = db.ref(`users/${userId}/wallet/greenDiamondBalance`);
        const balSnap = await walletRef.once('value');
        const balance = balSnap.val() || 0;

        if (balance < entryFee) return res.status(400).json({ success: false, message: "Insufficient Balance" });

        // ব্যালেন্স কাটা এবং জয়েন করানো
        await walletRef.set(balance - entryFee);
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
    console.log(`Server is running on port ${PORT}`);
});
              
