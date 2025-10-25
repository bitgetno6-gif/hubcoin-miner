import os
import json
import logging
import threading  # <-- ১. থ্রেডিং মডিউল ইম্পোর্ট করা হয়েছে
from datetime import date
from dotenv import load_dotenv

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import firebase_admin
from firebase_admin import credentials, firestore

import telegram
from telegram import Update, WebAppInfo, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, ContextTypes

# --- প্রাথমিক সেটআপ এবং কনফিগারেশন ---
logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)
load_dotenv()

# .env ফাইল থেকে ভেরিয়েবল লোড করা
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
FRONTEND_URL = os.getenv("FRONTEND_URL")
firebase_config_str = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON_STRING")
ADMIN_TELEGRAM_ID = int(os.getenv("ADMIN_TELEGRAM_ID", 0))

# Firebase সেটআপ
try:
    firebase_config = json.loads(firebase_config_str)
    cred = credentials.Certificate(firebase_config)
    if not firebase_admin._apps: # পুনরায় ইনিশিয়ালাইজেশন এড়ানোর জন্য চেক
        firebase_admin.initialize_app(cred)
    db = firestore.client()
    logging.info("Firebase successfully initialized!")
except Exception as e:
    logging.error(f"Firebase initialization failed: {e}")
    db = None

# --- Flask অ্যাপ (Web Service এর জন্য) ---
app = Flask(__name__, static_folder='static')

# CORS (Cross-Origin Resource Sharing) কনফিগারেশন
if FRONTEND_URL:
    CORS(app, resources={r"/api/*": {"origins": [FRONTEND_URL]}})
else:
    CORS(app, resources={r"/api/*": {"origins": "*"}}) # ডেভেলপমেন্টের জন্য

# --- Helper Functions (সহকারী ফাংশন) ---
def get_user_ref(user_id):
    return db.collection('users').document(str(user_id))

def create_new_user(user_id, username, referrer_id=None):
    user_data = {
        'username': username, 'balance': 0.0, 'gems': 0, 'unclaimedGems': 0,
        'refs': 0, 'adWatch': 0, 'todayIncome': 0.0, 'gemsClaimedToday': 0,
        'lastGemClaimDate': str(date.today()), 'totalWithdrawn': 0.0,
        'referredBy': referrer_id
    }
    get_user_ref(user_id).set(user_data)
    logging.info(f"New user created: {user_id}, Referred by: {referrer_id}")
    return user_data

# --- স্ট্যাটিক ফাইল সার্ভ করার জন্য রুট ---
@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static_files(path):
    if path != "index.html":
        return send_from_directory(app.static_folder, path)
    else:
        return serve_index()

# --- API Endpoints ---
@app.route("/api/user", methods=['POST'])
def get_or_create_user():
    data = request.json
    user_id = data.get('user_id')
    username = data.get('username', 'N/A')
    if not user_id: return jsonify({"error": "User ID missing"}), 400
    try:
        user_doc = get_user_ref(user_id).get()
        if user_doc.exists:
            return jsonify(user_doc.to_dict()), 200
        else:
            new_user = create_new_user(user_id, username)
            return jsonify(new_user), 201
    except Exception as e:
        logging.error(f"API Error on /api/user: {e}")
        return jsonify({"error": "Server error"}), 500

@app.route("/api/claim-gems", methods=['POST'])
def claim_gems():
    user_id = request.json.get('user_id')
    if not user_id: return jsonify({"error": "User ID missing"}), 400
    try:
        user_ref = get_user_ref(user_id)
        @firestore.transactional
        def update_gems_transaction(transaction, doc_ref):
            today_str = str(date.today())
            snapshot = doc_ref.get(transaction=transaction)
            unclaimed = snapshot.get('unclaimedGems')
            if unclaimed < 2:
                return {"success": False, "message": "You need at least 2 gems."}
            last_claim_date = snapshot.get('lastGemClaimDate')
            claimed_today = snapshot.get('gemsClaimedToday')
            if last_claim_date != today_str:
                claimed_today = 0
                transaction.update(doc_ref, {'lastGemClaimDate': today_str})
            if claimed_today >= 6:
                return {"success": False, "message": "Daily gem claiming limit reached (6/day)."}
            transaction.update(doc_ref, {
                'gems': firestore.Increment(2), 'unclaimedGems': firestore.Increment(-2),
                'gemsClaimedToday': firestore.Increment(2)
            })
            return {"success": True, "message": "2 Gems claimed!",
                    "data": {"gems": snapshot.get('gems') + 2, "unclaimedGems": snapshot.get('unclaimedGems') - 2}}
        result = update_gems_transaction(db.transaction(), user_ref)
        return jsonify(result), 200
    except Exception as e:
        logging.error(f"API Error on /api/claim-gems: {e}")
        return jsonify({"error": "Could not claim gems"}), 500

@app.route('/api/withdrawal', methods=['POST'])
def request_withdrawal():
    data = request.json
    user_id = data.get('user_id')
    amount = float(data.get('amount'))
    method = data.get('method')
    if not all([user_id, amount, method, data.get('account')]):
        return jsonify({'error': 'Missing fields'}), 400
    required_gems = 0
    if method in ['Bkash', 'Nagad']:
        if amount == 500: required_gems = 29
        elif amount == 1000: required_gems = 49
        elif amount == 1500: required_gems = 79
        else: required_gems = (amount / 500) * 50
    elif method == 'Binance':
        if amount == 5: required_gems = 58
        elif amount == 10: required_gems = 100
        elif amount == 15: required_gems = 150
        else: required_gems = amount * 10
    try:
        user_ref = get_user_ref(user_id)
        @firestore.transactional
        def withdrawal_transaction(transaction, doc_ref):
            snapshot = doc_ref.get(transaction=transaction)
            balance = snapshot.get('balance')
            gems = snapshot.get('gems')
            if balance < amount: return {"success": False, "error": "Insufficient balance."}
            if gems < required_gems: return {"success": False, "error": f"Insufficient gems. You need {int(required_gems)} gems."}
            transaction.update(doc_ref, {'balance': firestore.Increment(-amount), 'gems': firestore.Increment(-int(required_gems))})
            db.collection('withdrawals').add({
                'userId': user_id, 'amount': amount, 'method': method,
                'account': data.get('account'), 'status': 'pending', 'timestamp': firestore.SERVER_TIMESTAMP
            })
            return {"success": True, "message": "Withdrawal request submitted!",
                    "data": {"balance": balance - amount, "gems": gems - int(required_gems)}}
        result = withdrawal_transaction(db.transaction(), user_ref)
        return jsonify(result), 200
    except Exception as e:
        logging.error(f"API Error on /api/withdrawal: {e}")
        return jsonify({'error': 'Server error during withdrawal'}), 500

@app.route("/api/leaderboard", methods=['GET'])
def get_leaderboard():
    try:
        doc = db.collection('leaderboard').document('top_players').get()
        return jsonify(doc.to_dict() if doc.exists else {"players": []}), 200
    except Exception as e:
        logging.error(f"API Error on /api/leaderboard: {e}")
        return jsonify({"error": "Could not fetch leaderboard"}), 500

# --- Telegram Bot Command Handlers ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    user_id, username = str(user.id), user.username or user.first_name
    referrer_id = context.args[0] if context.args and context.args[0].isdigit() and context.args[0] != user_id else None
    if not get_user_ref(user_id).get().exists:
        create_new_user(user_id, username, referrer_id)
        if referrer_id:
            try:
                get_user_ref(referrer_id).update({
                    'balance': firestore.Increment(25.0), 'unclaimedGems': firestore.Increment(2),
                    'refs': firestore.Increment(1)
                })
                await context.bot.send_message(chat_id=referrer_id,
                    text=f"🎉 Congratulations! {user.first_name} joined using your link. You received 25 TK and 2 Gems!")
            except Exception as e:
                logging.error(f"Failed to reward referrer {referrer_id}: {e}")
    keyboard = [[InlineKeyboardButton("🚀 Open HubCoin Miner", web_app=WebAppInfo(url=FRONTEND_URL))]]
    await update.message.reply_html(
        rf"👋 Welcome, {user.mention_html()}! Click the button below to start earning.",
        reply_markup=InlineKeyboardMarkup(keyboard))

async def update_leaderboard_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_user.id != ADMIN_TELEGRAM_ID:
        return await update.message.reply_text("⛔ You are not authorized.")
    await update.message.reply_text("⏳ Updating leaderboard...")
    try:
        query = db.collection('users').order_by('totalWithdrawn', direction=firestore.Query.DESCENDING).limit(20)
        top_users = [{'rank': i + 1, 'username': doc.to_dict().get('username', 'N/A'),
                      'totalWithdrawn': doc.to_dict().get('totalWithdrawn', 0)} for i, doc in enumerate(query.stream())]
        db.collection('leaderboard').document('top_players').set({'players': top_users, 'lastUpdated': firestore.SERVER_TIMESTAMP})
        await update.message.reply_text(f"✅ Leaderboard updated with {len(top_users)} players!")
    except Exception as e:
        logging.error(f"Leaderboard update failed: {e}")
        await update.message.reply_text(f"❌ Failed to update leaderboard. Error: {e}")

# --- বট চালানোর জন্য ফাংশন ---
def run_bot():
    """টেলিগ্রাম বটটি পোলিং মোডে চালায়।"""
    application = Application.builder().token(BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("updateleaderboard", update_leaderboard_command))
    logging.info("Starting Telegram bot polling in a separate thread...")
    application.run_polling()

# --- মূল পরিবর্তন: বটকে আলাদা থ্রেডে চালানো ---
# Gunicorn যখন 'app' অবজেক্টটি লোড করবে, তখন এই কোডটিও রান হবে।
# এটি বটকে একটি ব্যাকগ্রাউন্ড থ্রেডে চালু করে দেবে এবং মূল থ্রেডে Flask অ্যাপ চলতে থাকবে।
bot_thread = threading.Thread(target=run_bot, daemon=True)
bot_thread.start()
logging.info("Bot thread has been initiated and is running in the background.")

# --- লোকাল টেস্টিং এর জন্য ---
if __name__ == "__main__":
    # নিজের কম্পিউটারে টেস্ট করার জন্য `python server.py` কমান্ড দিলে এটি রান হবে।
    logging.info("Starting Flask development server for local testing...")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))