const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Telegraf, Markup } = require('telegraf');
const path =require('path');
require('dotenv').config();

// --- 1. প্রাথমিক সেটআপ এবং কনফিগারেশন ---
const app = express();
const PORT = process.env.PORT || 10000;

// এনভায়রনমেন্ট ভেরিয়েবল লোড করা
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL;
const FIREBASE_CONFIG_STRING = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_STRING;
const ADMIN_TELEGRAM_ID = parseInt(process.env.ADMIN_TELEGRAM_ID || '0', 10);

// জরুরি ভেরিয়েবলগুলো চেক করা
if (!BOT_TOKEN || !FRONTEND_URL || !FIREBASE_CONFIG_STRING) {
    console.error("গুরুত্বপূর্ণ এনভায়রনমেন্ট ভেরিয়েবল (BOT_TOKEN, FRONTEND_URL, FIREBASE_CONFIG_STRING) সেট করা নেই!");
    process.exit(1); // অ্যাপ্লিকেশন বন্ধ করে দেওয়া
}

// Firebase সেটআপ
try {
    const serviceAccount = JSON.parse(FIREBASE_CONFIG_STRING);

    // 🔥 --- START: Firebase private key সমস্যার সমাধান --- 🔥
    // Render-এর এনভায়রনমেন্ট ভেরিয়েবলে private key-এর newline (\n) অক্ষরগুলো ঠিকমতো কাজ করার জন্য এই লাইনটি যোগ করা হয়েছে।
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    // 🔥 --- END: Firebase private key সমস্যার সমাধান --- 🔥

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    const db = admin.firestore();
    console.log("Firebase সফলভাবে ইনিশিয়ালাইজ হয়েছে!");

    // --- মিডলওয়্যার সেটআপ ---
    app.use(cors({ origin: [FRONTEND_URL, 'https://web.telegram.org'] }));
    app.use(express.json());
    // 'static' ফোল্ডার থেকে ফ্রন্টএন্ড ফাইলগুলো সার্ভ করার জন্য
    app.use(express.static(path.join(__dirname, 'static')));

    // --- Helper Functions (সহকারী ফাংশন) ---
    const getUserRef = (userId) => db.collection('users').doc(String(userId));

    const createNewUser = async (userId, username, referrerId = null) => {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD ফরম্যাট
        const userData = {
            username: username, balance: 0.0, gems: 0, unclaimedGems: 0,
            refs: 0, adWatch: 0, todayIncome: 0.0, gemsClaimedToday: 0,
            lastGemClaimDate: today, totalWithdrawn: 0.0,
            referredBy: referrerId
        };
        await getUserRef(userId).set(userData);
        console.log(`নতুন ব্যবহারকারী তৈরি হয়েছে: ${userId}, রেফার করেছেন: ${referrerId}`);
        return userData;
    };

    // --- API Endpoints ---
    app.post("/api/user", async (req, res) => {
        const { user_id, username } = req.body;
        if (!user_id) return res.status(400).json({ error: "User ID নেই" });

        try {
            const userDoc = await getUserRef(user_id).get();
            if (userDoc.exists) {
                return res.status(200).json(userDoc.data());
            } else {
                const newUser = await createNewUser(user_id, username || 'N/A');
                return res.status(201).json(newUser);
            }
        } catch (error) {
            console.error("API Error on /api/user:", error);
            return res.status(500).json({ error: "সার্ভার এরর" });
        }
    });

    app.post("/api/claim-gems", async (req, res) => {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: "User ID নেই" });
        
        try {
            const userRef = getUserRef(user_id);
            const result = await db.runTransaction(async (t) => {
                const doc = await t.get(userRef);
                if (!doc.exists) return { success: false, message: "ব্যবহারকারী খুঁজে পাওয়া যায়নি।" };

                const data = doc.data();
                const todayStr = new Date().toISOString().split('T')[0];
                let gemsClaimedToday = data.gemsClaimedToday || 0;

                if (data.unclaimedGems < 2) {
                    return { success: false, message: "আপনার অন্তত ২টি জেম প্রয়োজন।" };
                }
                
                if (data.lastGemClaimDate !== todayStr) {
                    gemsClaimedToday = 0;
                    t.update(userRef, { lastGemClaimDate: todayStr, gemsClaimedToday: 0 });
                }

                if (gemsClaimedToday >= 6) {
                    return { success: false, message: "দৈনিক জেম ক্লেম করার লিমিট শেষ (৬/দিন)।" };
                }

                t.update(userRef, {
                    gems: admin.firestore.FieldValue.increment(2),
                    unclaimedGems: admin.firestore.FieldValue.increment(-2),
                    gemsClaimedToday: admin.firestore.FieldValue.increment(2)
                });
                
                return { 
                    success: true, 
                    message: "২টি জেম ক্লেম করা হয়েছে!",
                    data: { gems: data.gems + 2, unclaimedGems: data.unclaimedGems - 2 }
                };
            });
            return res.status(200).json(result);
        } catch (error) {
            console.error("API Error on /api/claim-gems:", error);
            return res.status(500).json({ error: "জেম ক্লেম করা যায়নি" });
        }
    });

    app.post('/api/withdrawal', async (req, res) => {
        const { user_id, amount, method, account } = req.body;
        if (!user_id || !amount || !method || !account) {
            return res.status(400).json({ error: 'প্রয়োজনীয় তথ্য নেই' });
        }

        let required_gems = 0;
        // ... (আপনার জেমের হিসাব এখানে যোগ করুন) ...

        try {
            const userRef = getUserRef(user_id);
            const result = await db.runTransaction(async t => {
                const doc = await t.get(userRef);
                if (!doc.exists) return { success: false, error: "ব্যবহারকারী খুঁজে পাওয়া যায়নি।" };
                
                const data = doc.data();
                if (data.balance < amount) return { success: false, error: "অপর্যাপ্ত ব্যালেন্স।" };
                if (data.gems < required_gems) return { success: false, error: `অপর্যাপ্ত জেম। আপনার ${required_gems} জেম প্রয়োজন।` };

                t.update(userRef, {
                    balance: admin.firestore.FieldValue.increment(-amount),
                    gems: admin.firestore.FieldValue.increment(-required_gems)
                });
                
                const withdrawalRef = db.collection('withdrawals').doc();
                t.set(withdrawalRef, {
                    userId: user_id, amount, method, account,
                    status: 'pending', timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                
                return { 
                    success: true, 
                    message: "উইথড্রয়াল অনুরোধ সফলভাবে জমা দেওয়া হয়েছে!",
                    data: { balance: data.balance - amount, gems: data.gems - required_gems }
                };
            });
            res.status(200).json(result);
        } catch (error) {
            console.error("API Error on /api/withdrawal:", error);
            res.status(500).json({ error: 'সার্ভার এরর' });
        }
    });

    app.get("/api/leaderboard", async (req, res) => {
        try {
            const doc = await db.collection('leaderboard').doc('top_players').get();
            if (doc.exists) {
                return res.status(200).json(doc.data());
            }
            return res.status(200).json({ players: [] });
        } catch (error) {
            console.error("API Error on /api/leaderboard:", error);
            return res.status(500).json({ error: "লিডারবোর্ড লোড করা যায়নি" });
        }
    });


    // --- ক্যাচ-অল রুট: যেকোনো লিঙ্কে index.html পাঠানো ---
    // এটি নিশ্চিত করে যে সরাসরি কোনো লিঙ্কে গেলেও আপনার সিঙ্গেল-পেজ অ্যাপটি লোড হবে।
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'static', 'index.html'));
    });

    // --- Telegram Bot সেটআপ ---
    const bot = new Telegraf(BOT_TOKEN);

    bot.start(async (ctx) => {
        const user = ctx.from;
        const userId = String(user.id);
        const username = user.username || user.first_name;
        // রেফারেল আইডি পাওয়ার জন্য (t.me/bot?start=ref_id)
        const referrerId = ctx.startPayload && /^\d+$/.test(ctx.startPayload) ? ctx.startPayload : null;

        try {
            const userDoc = await getUserRef(userId).get();
            if (!userDoc.exists) {
                await createNewUser(userId, username, referrerId);
                if (referrerId && referrerId !== userId) {
                    const referrerRef = getUserRef(referrerId);
                    await referrerRef.update({
                        balance: admin.firestore.FieldValue.increment(25.0),
                        unclaimedGems: admin.firestore.FieldValue.increment(2),
                        refs: admin.firestore.FieldValue.increment(1)
                    });
                    await ctx.telegram.sendMessage(referrerId, `🎉 অভিনন্দন! ${user.first_name} আপনার লিঙ্কে জয়েন করেছে। আপনি 25 TK এবং 2 Gems পেয়েছেন!`);
                }
            }
        } catch (error) {
            console.error("Start command error:", error);
        }

        const keyboard = Markup.inlineKeyboard([
            Markup.button.webApp("🚀 Open HubCoin Miner", FRONTEND_URL)
        ]);

        await ctx.replyWithHTML(
            `👋 স্বাগতম, <b>${user.first_name}</b>! উপার্জন শুরু করতে নিচের বাটনে ক্লিক করুন।`,
            keyboard
        );
    });
    
    // ... এখানে আপনার বাকি বট কমান্ডগুলো (যেমন updateleaderboard) যোগ করতে পারেন ...

    // বট চালু করা
    bot.launch();
    console.log("টেলিগ্রাম বট সফলভাবে চালু হয়েছে!");

    // Express সার্ভার চালু করা
    app.listen(PORT, () => {
        console.log(`সার্ভার পোর্ট ${PORT}-এ চালু হয়েছে`);
    });

} catch (e) {
    console.error("প্রাথমিক সেটআপ ব্যর্থ হয়েছে:", e);
    process.exit(1);
}