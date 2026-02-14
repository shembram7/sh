const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// Firebase Setup
try {
    let serviceAccount;
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        try { serviceAccount = require('./serviceAccountKey.json'); } catch (e) {}
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // ⚠️ আপনার ডাটাবেস লিংকটি এখানে হার্ডকোড করে দিলাম যাতে ভুল না হয়
            databaseURL: process.env.FIREBASE_DATABASE_URL || "https://roktobij-4210b-default-rtdb.firebaseio.com"
        });
    }
} catch (e) {
    console.error("Firebase Init Error:", e.message);
}

const db = admin.apps.length ? admin.database() : null;

// ==========================================
// 🚀 API: টুর্নামেন্ট লিস্ট (FIXED)
// ==========================================
app.get('/api/tournaments', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database Error" });

    try {
        const snapshot = await db.ref('tournaments').once('value');
        const tournaments = [];

        snapshot.forEach((child) => {
            const data = child.val();
            
            // আপনার ডাটাবেস স্ট্রাকচার অনুযায়ী আপডেট করা হলো
            tournaments.push({
                id: child.key,
                title: data.title || data.gameName || "Tournament", // title না থাকলে gameName দেখাবে
                prize: data.prizePool || data.prize || "0",        // prizePool থেকে ডাটা নেবে
                entryFee: parseInt(data.entryFee || 0),
                status: data.status || "Upcoming",                 // আপনার ডিফল্ট স্ট্যাটাস
                map: data.map || "",                               // ম্যাপের নাম (Bermuda)
                schedule: data.schedule || ""                      // সময়
            });
        });

        // যদি লিস্ট ফাঁকা হয়
        if (tournaments.length === 0) {
            console.log("Database connected but no tournaments found!");
        }

        res.json({ success: true, data: tournaments.reverse() });

    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ... (বাকি API গুলো যেমন join-tournament, claim-reward আগের মতোই থাকবে) ...
// শুধু উপরের get API টা আপডেট করলেই হবে।

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(Server running on port ${PORT});
});
