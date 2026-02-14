const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin SDK কনফিগারেশন
// ---------------------------------------------------
try {
    // Render এ environment variable থেকে অথবা লোকাল ফাইল থেকে কি (key) নেওয়া
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
        : require('./serviceAccountKey.json'); // লোকাল টেস্টের জন্য

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });

} catch (e) {
    console.error("Failed to initialize Firebase Admin SDK:", e.message);
    process.exit(1);
}

const db = admin.database();
// ---------------------------------------------------

// রিওয়ার্ডের পরিমাণ
const REFERRAL_BONUS_AMOUNT_IN_DIAMONDS = 500;

// API রুট: রেফারেল কোড রিডিম করার জন্য
app.post('/redeem-referral', async (req, res) => {
    const { code, userId } = req.body;

    if (!userId) {
        return res.status(401).json({ message: "User is not authenticated." });
    }
    if (!code) {
        return res.status(400).json({ message: "Referral code is required." });
    }

    try {
        // ১. যিনি কোড ব্যবহার করছেন (New User) তার ডাটা চেক করা
        const newUserRef = db.ref(`users/${userId}`);
        const newUserSnapshot = await newUserRef.once("value");
        const newUserData = newUserSnapshot.val();

        if (!newUserData) {
            return res.status(404).json({ message: "User not found." });
        }
        if (newUserData.referredBy) {
            return res.status(409).json({ message: "You have already redeemed a code." });
        }
        if (newUserData.referCode === code) {
            return res.status(400).json({ message: "You cannot redeem your own code." });
        }

        // ২. যার কোড ব্যবহার করা হচ্ছে (Referrer) তাকে খুঁজে বের করা
        const query = db.ref("users").orderByChild("referCode").equalTo(code);
        const referrerSnapshot = await query.once("value");

        if (!referrerSnapshot.exists()) {
            return res.status(404).json({ message: "Invalid referral code." });
        }

        const referrerId = Object.keys(referrerSnapshot.val())[0];

        // ============================================================
        // ৩. ব্যালেন্স আপডেট করা (সঠিক ওয়ালেট পাথে)
        // ============================================================
        
        // A. নতুন ইউজারের ব্যালেন্স আপডেট + referredBy সেট করা
        await newUserRef.child('wallet').update({
            greenDiamondBalance: admin.database.ServerValue.increment(REFERRAL_BONUS_AMOUNT_IN_DIAMONDS)
        });
        await newUserRef.update({ referredBy: referrerId });

        // B. রেফারারের ব্যালেন্স আপডেট
        await db.ref(`users/${referrerId}/wallet`).update({
            greenDiamondBalance: admin.database.ServerValue.increment(REFERRAL_BONUS_AMOUNT_IN_DIAMONDS)
        });

        // ============================================================
        // ৪. হিস্ট্রি সেভ করা (উভয় ইউজারের জন্য)
        // ============================================================

        // --- ফাংশন: হিস্ট্রি তৈরি করার জন্য ---
        const addHistory = async (targetUid, methodText, transactionId) => {
            const historyRef = db.ref(`walletHistory/${targetUid}`);
            const newHistoryRef = historyRef.push(); // নতুন ইউনিক key তৈরি
            
            await newHistoryRef.set({
                amount: REFERRAL_BONUS_AMOUNT_IN_DIAMONDS,
                id: newHistoryRef.key,
                method: methodText,          // যেমন: "Referral Bonus"
                status: "approved",          // অ্যাপে সবুজ দেখানোর জন্য
                timestamp: admin.database.ServerValue.TIMESTAMP,
                transactionId: transactionId || "",
                type: "Reward",              // "Reward" দিলে অ্যাপে গ্রিন কালার আসবে
                userId: targetUid
            });
        };

        // নতুন ইউজারের হিস্ট্রি যোগ
        await addHistory(userId, "Referral Bonus (Joined)", referrerId);

        // রেফারারের হিস্ট্রি যোগ
        await addHistory(referrerId, "Referral Bonus (Invite)", userId);

        return res.status(200).json({
            success: true,
            message: `Successfully redeemed! You both earned ${REFERRAL_BONUS_AMOUNT_IN_DIAMONDS} diamonds!`
        });

    } catch (error) {
        console.error("Error redeeming code:", error);
        return res.status(500).json({ message: "An internal server error occurred." });
    }
});

// সার্ভার চালু করুন
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
