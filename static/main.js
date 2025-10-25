document.addEventListener("DOMContentLoaded", function() {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();

    // API Base URL টি আপনার Render Backend URL অনুযায়ী সেট করা হয়েছে।
    const API_BASE_URL = 'https://hubcoin-tuft.onrender.com/api'; 
    // ⚠️ আপনার টেলিগ্রাম বটের ইউজারনেম দিন
    const BOT_USERNAME = 'HubCoin_minerbot'; 

    const elements = {
        loadingOverlay: document.getElementById('loading-overlay'),
        userName: document.getElementById('user-name'),
        userProfilePic: document.getElementById('user-profile-pic'),
        totalBalance: document.getElementById('total-balance'),
        totalBalanceProfile: document.getElementById('total-balance-profile'),
        totalGems: document.getElementById('total-gems'),
        totalRefs: document.getElementById('total-refs'),
        totalAdWatch: document.getElementById('total-ad-watch'),
        todayIncome: document.getElementById('today-income'),
        refLink: document.getElementById('ref-link'),
        unclaimedGems: document.getElementById('unclaimed-gems'),
        navButtons: document.querySelectorAll('.nav-button'),
        pages: document.querySelectorAll('.page'),
        copyButton: document.querySelector('.btn-copy'),
        watchAdBtn: document.getElementById('watch-ad-btn'),
        joinTelegramBtn: document.getElementById('join-telegram-btn'),
        claimGemsBtn: document.getElementById('claim-gems-btn'),
        requestWithdrawalCard: document.getElementById('request-withdrawal-card'),
        // Withdrawal Modal Elements
        withdrawalModal: document.getElementById('withdrawal-modal'),
        closeModalBtn: document.getElementById('close-modal-btn'),
        paymentBtns: document.querySelectorAll('.payment-btn'),
        amountSelectionArea: document.getElementById('amount-selection-area'),
        amountOptions: document.getElementById('amount-options'),
        gemRequirementMsg: document.getElementById('gem-requirement-msg'),
        customAmountGroup: document.getElementById('custom-amount-group'),
        customAmountInput: document.getElementById('custom-amount'),
        customGemRequirementMsg: document.getElementById('custom-gem-requirement-msg'),
        accountDetailsArea: document.getElementById('account-details-area'),
        accountInput: document.getElementById('account-number'),
        accountLabel: document.getElementById('account-label'),
        submitWithdrawalBtn: document.getElementById('submit-withdrawal-btn'),
    };

    let currentUserData = {};
    let withdrawalState = {
        method: null,
        amount: null,
        isCustom: false,
        requiredGems: 0
    };
    const user = tg.initDataUnsafe?.user;

    // --- API কমিউনিকেশন ---
    async function fetchApi(endpoint, method = 'POST', body = {}) {
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, user_id: user?.id, user_data: tg.initData })
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error(`API Error at ${endpoint}:`, error);
            Swal.fire('Error', error.message, 'error');
            return null;
        }
    }

    // --- UI আপডেট ফাংশন ---
    function updateUI(data) {
        currentUserData = data;
        elements.totalBalance.textContent = `৳ ${data.balance.toFixed(2)}`;
        elements.totalBalanceProfile.textContent = `৳ ${data.balance.toFixed(2)}`;
        elements.totalGems.textContent = data.gems;
        elements.totalRefs.textContent = data.refs;
        elements.totalAdWatch.textContent = data.adWatch;
        elements.todayIncome.textContent = `৳ ${data.todayIncome.toFixed(2)}`;
        elements.unclaimedGems.textContent = data.unclaimedGems || 0;
        elements.refLink.textContent = `https://t.me/${BOT_USERNAME}?start=${user?.id}`;
    }

    // --- পেজ পরিবর্তন ---
    function switchPage(targetPageId) {
        elements.pages.forEach(page => page.classList.remove('page-active'));
        document.getElementById(targetPageId)?.classList.add('page-active');
    }

    // --- উইথড্রয়াল মডাল লজিক ---
    const withdrawalConfig = {
        'Bkash': { type: 'TK', amounts: [500, 1000, 1500], gems: [29, 49, 79], customGemRate: 50 },
        'Nagad': { type: 'TK', amounts: [500, 1000, 1500], gems: [29, 49, 79], customGemRate: 50 },
        'Binance': { type: 'USD', amounts: [5, 10, 15], gems: [58, 100, 150], customGemRate: 10 } // প্রতি ডলারের জন্য ১০ জেম (উদাহরণ)
    };

    function updateAmountButtons() {
        elements.amountOptions.innerHTML = '';
        const config = withdrawalConfig[withdrawalState.method];
        if (!config) return;

        config.amounts.forEach((amount, index) => {
            const btn = document.createElement('button');
            btn.className = 'amount-btn';
            btn.dataset.amount = amount;
            btn.dataset.gems = config.gems[index];
            btn.textContent = `${config.type === 'TK' ? '৳' : '$'} ${amount}`;
            elements.amountOptions.appendChild(btn);
        });

        const customBtn = document.createElement('button');
        customBtn.className = 'amount-btn';
        customBtn.dataset.amount = 'custom';
        customBtn.textContent = 'Custom';
        elements.amountOptions.appendChild(customBtn);

        elements.amountSelectionArea.style.display = 'block';
    }

    function checkCanSubmit() {
        const { amount, method, requiredGems } = withdrawalState;
        const account = elements.accountInput.value;
        if (amount && method && account) {
            if (currentUserData.balance >= amount && currentUserData.gems >= requiredGems) {
                elements.submitWithdrawalBtn.disabled = false;
                return;
            }
        }
        elements.submitWithdrawalBtn.disabled = true;
    }
    
    // --- ইভেন্ট লিসেনার সেটআপ ---
    function setupEventListeners() {
        elements.navButtons.forEach(button => button.addEventListener('click', () => {
            const targetPageId = 'page-' + button.dataset.page;
            elements.navButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            switchPage(targetPageId);
            if (targetPageId === 'page-leaderboard') loadLeaderboard();
        }));

        elements.copyButton.addEventListener('click', () => {
            navigator.clipboard.writeText(elements.refLink.textContent)
                .then(() => Swal.fire({ toast: true, position: 'top-end', text: 'Copied!', showConfirmButton: false, timer: 1500, icon: 'success' }));
        });

        elements.watchAdBtn.addEventListener('click', async () => { /* ... Watch Ad Logic ... */ });
        elements.joinTelegramBtn.addEventListener('click', async () => { /* ... Join Telegram Logic ... */ });
        elements.claimGemsBtn.addEventListener('click', async () => { /* ... Claim Gems Logic ... */ });

        // --- প্রোফাইল এবং মডাল ---
        elements.requestWithdrawalCard.addEventListener('click', () => elements.withdrawalModal.style.display = 'flex');
        elements.closeModalBtn.addEventListener('click', () => elements.withdrawalModal.style.display = 'none');
        elements.withdrawalModal.addEventListener('click', e => { if (e.target === elements.withdrawalModal) elements.withdrawalModal.style.display = 'none'; });

        // উইথড্রয়াল মডাল ইভেন্ট
        elements.paymentBtns.forEach(btn => btn.addEventListener('click', () => {
            elements.paymentBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            withdrawalState.method = btn.dataset.method;
            updateAmountButtons();
            elements.accountDetailsArea.style.display = 'none';
            elements.customAmountGroup.style.display = 'none';
            elements.accountLabel.textContent = withdrawalState.method === 'Binance' ? 'Binance Pay ID' : 'Account Number';
        }));

        elements.amountOptions.addEventListener('click', (e) => {
            if (e.target.classList.contains('amount-btn')) {
                document.querySelectorAll('.amount-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                
                const amount = e.target.dataset.amount;
                if (amount === 'custom') {
                    withdrawalState.isCustom = true;
                    withdrawalState.amount = null;
                    elements.customAmountGroup.style.display = 'block';
                    elements.gemRequirementMsg.textContent = '';
                } else {
                    withdrawalState.isCustom = false;
                    withdrawalState.amount = Number(amount);
                    withdrawalState.requiredGems = Number(e.target.dataset.gems);
                    elements.customAmountGroup.style.display = 'none';
                    elements.gemRequirementMsg.textContent = `Requires ${withdrawalState.requiredGems} Gems.`;
                }
                elements.accountDetailsArea.style.display = 'block';
                checkCanSubmit();
            }
        });

        elements.customAmountInput.addEventListener('input', () => {
            const amount = Number(elements.customAmountInput.value);
            const config = withdrawalConfig[withdrawalState.method];
            if (amount > 0 && config) {
                withdrawalState.amount = amount;
                if (config.type === 'TK') {
                    withdrawalState.requiredGems = Math.ceil(amount / 500) * config.customGemRate;
                } else {
                    withdrawalState.requiredGems = Math.ceil(amount) * config.customGemRate;
                }
                elements.customGemRequirementMsg.textContent = `Requires ${withdrawalState.requiredGems} Gems.`;
            } else {
                withdrawalState.amount = null;
            }
            checkCanSubmit();
        });

        elements.accountInput.addEventListener('input', checkCanSubmit);

        elements.submitWithdrawalBtn.addEventListener('click', async () => {
            Swal.fire({ title: 'Processing...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            const result = await fetchApi('/withdrawal', 'POST', {
                amount: withdrawalState.amount,
                method: withdrawalState.method,
                account: elements.accountInput.value
            });
            if (result && result.success) {
                elements.withdrawalModal.style.display = 'none';
                Swal.fire('Success!', result.message, 'success');
                updateUI(result.data); // ব্যালেন্স এবং জেম আপডেট করুন
            }
        });
    }
    
    // --- লিডারবোর্ড লোড করা ---
    async function loadLeaderboard() { /* ... Leaderboard Logic ... */ }

    // --- অ্যাপ ইনিশিয়ালাইজেশন ---
    async function initializeApp() {
        if (!user?.id) {
            document.body.innerHTML = "<h1>Please open this app through your Telegram client.</h1>";
            return;
        }

        elements.userName.textContent = user.first_name || 'Guest';
        // প্রোফাইল ছবি দেখানোর জন্য
        // try {
        //     const photos = await tg.getUserProfilePhotos({user_id: user.id, limit: 1});
        //     if(photos.total_count > 0) elements.userProfilePic.src = photos.photos[0][0].file_id;
        // } catch (e) { console.error("Could not load profile photo", e); }

        const userData = await fetchApi('/user', 'POST', { username: user.username || user.first_name });
        
        if (userData) {
            updateUI(userData);
            setupEventListeners();
        }

        elements.loadingOverlay.style.opacity = '0';
        setTimeout(() => elements.loadingOverlay.style.display = 'none', 500);
    }

    initializeApp();
});

// Helper functions for tasks and leaderboard can be added here
// For example:
async function claimGemsLogic() { /* ... */ }