// Dashboard language: English (default) or Bangla, switched from the top bar
// of admin.html and dashboard.html and remembered in this browser.
//
// The pages are written in English. BN maps an exact English phrase to its
// Bangla text: when Bangla is on, any text node (or aria-label, placeholder,
// title) whose trimmed text is exactly one of these phrases is shown in
// Bangla, including text the desk scripts render later (a MutationObserver
// watches the page). Switching back restores the original English. Scripts
// that build text themselves call cpayI18n.t('English phrase').
//
// Display only: nothing here changes what the server accepts.
(function () {
  'use strict';
  const BN = {
    // Passkey-only sign-in (20261021020000)
    "Use the Lightning address of a wallet you control. CPAY checks that the wallet provider can confirm payments before you can save it. Payers see this address on the payment page. Saving or changing it needs your passkey and is used right away. You get a notice in your inbox each time it changes.": "আপনার নিয়ন্ত্রণে থাকা ওয়ালেটের Lightning ঠিকানা দিন। সংরক্ষণের আগে CPAY যাচাই করে যে ওয়ালেট প্রোভাইডার পেমেন্ট নিশ্চিত করতে পারে। পেমেন্টকারীরা পেমেন্ট পাতায় এই ঠিকানা দেখেন। সংরক্ষণ বা বদলাতে পাসকি লাগে, আর সঙ্গে সঙ্গে কাজ করে। প্রতিবার বদলালে ইনবক্সে নোটিশ আসে।",
    "Confirm with your passkey to change address. It is used right away. You get a notice in your inbox.": "ঠিকানা বদলাতে পাসকি দিয়ে নিশ্চিত করুন। সঙ্গে সঙ্গে কাজ করে। ইনবক্সে নোটিশ আসে।",
    "Confirm with your passkey to change address": "ঠিকানা বদলাতে পাসকি দিয়ে নিশ্চিত করুন",
    "Your saved address is not ready yet. Payments start once it is.": "আপনার সংরক্ষিত ঠিকানা এখনো প্রস্তুত নয়। প্রস্তুত হলে পেমেন্ট শুরু হবে।",
    "Add a passkey and continue": "পাসকি যোগ করে চালিয়ে যান",
    "This account needs a passkey. Add one now with your fingerprint, face or screen lock; you then sign in with it.": "এই অ্যাকাউন্টে পাসকি লাগবে। এখনই আঙুলের ছাপ, মুখ বা স্ক্রিন লক দিয়ে একটি যোগ করুন; এরপর সেটি দিয়ে সাইন-ইন করবেন।",
    "Passkeys are not available right now. Ask the owner to switch them on.": "পাসকি এখন চালু নেই। মালিককে চালু করতে বলুন।",
    "Passkeys are not available right now.": "পাসকি এখন চালু নেই।",
    "Authenticator app (no longer used)": "Authenticator অ্যাপ (আর ব্যবহার হয় না)",
    "CPAY now uses passkeys instead of authenticator codes. Add a passkey above; after that your old authenticator is not needed.": "CPAY এখন authenticator কোডের বদলে পাসকি ব্যবহার করে। উপরে একটি পাসকি যোগ করুন; এরপর পুরনো authenticator আর লাগবে না।",
    "Passkeys": "পাসকি",
    "Admin work needs a passkey sign-in. Add two passkeys (for example your phone and your password manager) so losing one device does not lock you out.": "অ্যাডমিনের কাজে পাসকি দিয়ে সাইন-ইন লাগে। দুটি পাসকি যোগ করুন (যেমন ফোন আর পাসওয়ার্ড ম্যানেজার), যাতে একটি ডিভাইস হারালে আটকে না যান।",
    "Sign in, confirm payouts and change payout addresses with your fingerprint, face or screen lock. The passkey is kept by this device or your password manager.": "আঙুলের ছাপ, মুখ বা স্ক্রিন লক দিয়ে সাইন-ইন, পেআউট নিশ্চিত আর পেআউট ঠিকানা বদলান। পাসকি এই ডিভাইস বা আপনার পাসওয়ার্ড ম্যানেজারে থাকে।",
    "This browser cannot use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.": "এই ব্রাউজারে পাসকি চলে না। নতুন Chrome, Safari, Edge বা Firefox ব্যবহার করুন।",
    "Your passkeys did not load. Reload the page to try again.": "আপনার পাসকি লোড হয়নি। পেজ রিলোড করে আবার চেষ্টা করুন।",
    "Admins need a passkey: add another one before removing this one.": "অ্যাডমিনের পাসকি লাগে: এটি সরানোর আগে আরেকটি যোগ করুন।",
    "No passkey yet.": "এখনও কোনো পাসকি নেই।",
    "Add another passkey": "আরেকটি পাসকি যোগ করুন",
    "Add a passkey": "পাসকি যোগ করুন",
    "Use a passkey you already have, to add another.": "আরেকটি যোগ করতে আগের পাসকিটি ব্যবহার করুন।",
    "Confirm with your passkey to remove a passkey.": "পাসকি সরাতে আপনার পাসকি দিয়ে নিশ্চিত করুন।",
    "Confirm with your passkey": "পাসকি দিয়ে নিশ্চিত করুন",
    "Use my passkey": "আমার পাসকি ব্যবহার করুন",
    "Use your fingerprint, face or screen lock to continue.": "চালিয়ে যেতে আঙুলের ছাপ, মুখ বা স্ক্রিন লক ব্যবহার করুন।",
    "Use your passkey to finish signing in.": "সাইন-ইন শেষ করতে আপনার পাসকি ব্যবহার করুন।",
    "Use your passkey to confirm this payout.": "এই পেআউট নিশ্চিত করতে আপনার পাসকি ব্যবহার করুন।",
    "Passkey sign-in did not work. Try again.": "পাসকি দিয়ে সাইন-ইন হয়নি। আবার চেষ্টা করুন।",
    "Passkeys are not available on this page. Reload and try again.": "এই পেজে পাসকি চালু নেই। রিলোড করে আবার চেষ্টা করুন।",
    "For your security, sign in again with your passkey or password to confirm this payout.": "নিরাপত্তার জন্য, এই পেআউট নিশ্চিত করতে পাসকি বা পাসওয়ার্ড দিয়ে আবার সাইন-ইন করুন।",
    "Sign in again with your passkey, then repeat this.": "পাসকি দিয়ে আবার সাইন-ইন করে আবার চেষ্টা করুন।",
    "Sign in with a passkey": "পাসকি দিয়ে সাইন-ইন",
    // Navigation and shell
    'Overview': 'সারসংক্ষেপ', 'Daily earnings': 'দৈনিক আয়', 'People': 'ব্যবহারকারী', 'Manage users': 'ব্যবহারকারী পরিচালনা',
    'Applications': 'আবেদন', 'Inbox': 'ইনবক্স', 'Money': 'অর্থ', 'Payments': 'পেমেন্ট', 'Payouts': 'পেআউট',
    'Instant forwards': 'তাৎক্ষণিক ফরোয়ার্ড', 'Links': 'লিংক', 'Wallet': 'ওয়ালেট', 'Operations': 'পরিচালনা',
    'Health': 'সিস্টেমের অবস্থা', 'Receipt review': 'রসিদ যাচাই', 'System': 'সিস্টেম', 'Audit': 'অডিট লগ',
    'Settings': 'সেটিংস', 'Security': 'নিরাপত্তা', 'Log out': 'লগ আউট', 'Users': 'ব্যবহারকারী', 'More': 'আরও', 'Locations': 'অবস্থান',
    'CPAY admin': 'CPAY অ্যাডমিন', 'Administrator': 'অ্যাডমিনিস্ট্রেটর', 'Admin': 'অ্যাডমিন',
    'Workspace': 'কাজের জায়গা', 'Payment links': 'পেমেন্ট লিংক', 'Withdraw': 'উত্তোলন', 'Account': 'অ্যাকাউন্ট',
    'Download wallet': 'ওয়ালেট ডাউনলোড', 'Chat': 'চ্যাট', 'Profile': 'প্রোফাইল', 'Freelancer desk': 'ফ্রিল্যান্সার ডেস্ক',
    'Freelancer': 'ফ্রিল্যান্সার', 'Open menu': 'মেনু খুলুন', 'Close menu': 'মেনু বন্ধ করুন', 'Sections': 'বিভাগ',
    'Main sections': 'প্রধান বিভাগ', 'Skip to admin desk': 'অ্যাডমিন ডেস্কে যান', 'Skip to your desk': 'আপনার ডেস্কে যান',
    // Common words
    'Save': 'সংরক্ষণ করুন', 'Cancel': 'বাতিল', 'On': 'চালু', 'Off': 'বন্ধ', 'Saving…': 'সংরক্ষণ হচ্ছে…', 'Saved': 'সংরক্ষিত',
    'Add': 'যোগ করুন', 'Remove': 'সরিয়ে দিন', 'Delete': 'মুছে ফেলুন', 'Edit': 'সম্পাদনা', 'Status': 'অবস্থা', 'When': 'কখন',
    'Who': 'কে', 'Close': 'বন্ধ করুন', 'Refresh': 'রিফ্রেশ', 'Loading…': 'লোড হচ্ছে…', 'Search': 'খুঁজুন', 'Yes': 'হ্যাঁ', 'No': 'না',
    'Advanced': 'উন্নত', 'Setting': 'সেটিং', 'From': 'আগে', 'To': 'এখন', 'Now': 'এখন', 'default': 'ডিফল্ট', '(none)': '(কিছু নেই)',
    '(empty)': '(খালি)', '(not set)': '(সেট করা নেই)',
    // Settings page
    'Payment mode': 'পেমেন্ট মোড', 'Platform fee': 'প্ল্যাটফর্ম ফি', 'Fee %': 'ফি %', 'Save fee': 'ফি সংরক্ষণ করুন',
    'Save payment mode': 'পেমেন্ট মোড সংরক্ষণ করুন', 'Balance': 'ব্যালেন্স', 'Instant forward': 'তাৎক্ষণিক ফরোয়ার্ড',
    'Direct (no fee)': 'সরাসরি (ফি নেই)', 'Legal pages': 'আইনি পাতা', 'Wallet link': 'ওয়ালেট লিংক',
    'Settings changes': 'সেটিংস পরিবর্তনের ইতিহাস', 'No changes yet': 'এখনো কোনো পরিবর্তন নেই',
    'Features': 'ফিচার চালু/বন্ধ', 'Domains': 'ডোমেইন', 'Secrets & keys': 'গোপন কী ও টোকেন', 'Cloudflare': 'Cloudflare',
    'Domain': 'ডোমেইন', 'Purpose': 'কাজ', 'Add domain': 'ডোমেইন যোগ করুন', 'Turn on': 'চালু করুন', 'Turn off': 'বন্ধ করুন',
    'Main site': 'মূল সাইট', 'Payment links and site': 'পেমেন্ট লিংক ও সাইট', 'Payment links only': 'শুধু পেমেন্ট লিংক',
    'Site only': 'শুধু সাইট', 'No domains yet': 'এখনো কোনো ডোমেইন নেই', 'Supabase secrets': 'Supabase সিক্রেট',
    'Cloudflare Worker secrets': 'Cloudflare Worker সিক্রেট', 'Add or replace a secret': 'সিক্রেট যোগ বা বদলান',
    'Name': 'নাম', 'Value': 'মান', 'Set secret': 'সিক্রেট সেট করুন', 'Replace': 'বদলান', 'Protected': 'সুরক্ষিত',
    'Not set up yet': 'এখনো সেটআপ হয়নি', 'Always Use HTTPS': 'সবসময় HTTPS ব্যবহার', 'Language': 'ভাষা',
    'Used for': 'কাজে লাগে', 'Set': 'সেট আছে', 'Missing': 'নেই', 'Other': 'অন্যান্য',
    'Changes need two-step sign-in and are recorded below. Settings marked ⚠ ask for confirmation.': 'পরিবর্তনের জন্য দুই ধাপের সাইন-ইন লাগে এবং নিচে লেখা থাকে। ⚠ চিহ্নিত সেটিং নিশ্চিত করতে বলে।',
    'Payments go to the CPAY wallet. CPAY keeps the fee and the rest is added to the user’s CPAY balance. Users withdraw. This is how CPAY works today.': 'পেমেন্ট CPAY ওয়ালেটে আসে। CPAY ফি রাখে, বাকিটা ব্যবহারকারীর CPAY ব্যালেন্সে যোগ হয়। ব্যবহারকারী উত্তোলন করেন।',
    'Payments go to the CPAY wallet. CPAY keeps the fee and sends the rest straight to the user’s own Lightning address. No balances are kept.': 'পেমেন্ট CPAY ওয়ালেটে আসে। CPAY ফি রাখে, বাকিটা সঙ্গে সঙ্গে ব্যবহারকারীর নিজের Lightning address-এ পাঠায়। কোনো ব্যালেন্স রাখা হয় না।',
    'Payers pay the user’s own wallet directly. CPAY never receives the money and takes no fee.': 'পেমেন্টকারী সরাসরি ব্যবহারকারীর নিজের ওয়ালেটে পেমেন্ট করেন। CPAY টাকা ধরে না, কোনো ফি নেয় না।',
    'CPAY’s fee on each payment, in Balance and Instant forward modes. An account’s own fee (Manage users) wins over this.': 'প্রতিটি পেমেন্টে CPAY-এর ফি (ব্যালেন্স ও তাৎক্ষণিক ফরোয়ার্ড মোডে)। কোনো অ্যাকাউন্টের নিজস্ব ফি (ব্যবহারকারী পরিচালনা) থাকলে সেটিই প্রযোজ্য।',
    'Legal entity name': 'প্রতিষ্ঠানের আইনি নাম', 'Registered address': 'নিবন্ধিত ঠিকানা', 'Legal pages effective date': 'আইনি পাতা কার্যকর হওয়ার তারিখ',
    'Governing law jurisdiction': 'প্রযোজ্য আইনের এলাকা', 'Courts with jurisdiction': 'এখতিয়ারভুক্ত আদালত', 'Privacy contact email': 'গোপনীয়তা বিষয়ক ইমেইল',
    // Dashboard screens (phase 2)
    "New payments go straight to your own address": "নতুন পেমেন্ট সরাসরি আপনার নিজের ঠিকানায় যায়",
    "How payments work": "পেমেন্ট যেভাবে কাজ করে",
    "CPAY receives each payment, keeps the platform fee below and sends the rest straight to the freelancer’s own Lightning or USDT address. CPAY keeps no balances: a freelancer without a payout address cannot take new payments until they add one.": "CPAY প্রতিটি পেমেন্ট নেয়, নিচের প্ল্যাটফর্ম ফি রাখে এবং বাকিটা সরাসরি ফ্রিল্যান্সারের নিজের Lightning বা USDT ঠিকানায় পাঠায়। CPAY কোনো ব্যালেন্স রাখে না: যার পেআউট ঠিকানা নেই, ঠিকানা না দেওয়া পর্যন্ত সে নতুন পেমেন্ট নিতে পারবে না।",
    "Changing this asks you to sign in again. It is used right away if you confirm with your passkey, otherwise after 24 hours. You get a notice in your inbox.": "এটি বদলাতে আবার সাইন-ইন করতে হয়। অ্যাকাউন্টে authenticator থাকলে সঙ্গে সঙ্গে কাজ করে, না থাকলে ২৪ ঘণ্টা পরে। আপনার ইনবক্সে নোটিশ আসে।",
    "\"You receive\" already has both fees taken off.": "\"আপনি পাবেন\"-এ দুটি ফি আগেই বাদ দেওয়া আছে।",
    "(no limit)": "(সীমা নেই)",
    "6-digit code": "৬ অঙ্কের কোড",
    "Account type": "অ্যাকাউন্টের ধরন",
    "Account updated": "অ্যাকাউন্ট আপডেট হয়েছে",
    "Accounts": "অ্যাকাউন্ট",
    "Action": "কাজ",
    "Actions": "কাজ",
    "Active": "সক্রিয়",
    "Active accounts": "সক্রিয় অ্যাকাউন্ট",
    "Added on top of what the payer pays. This is separate from the platform fee.": "পেমেন্টকারী যা দেন তার উপর যোগ হয়। এটি প্ল্যাটফর্ম ফি থেকে আলাদা।",
    "Added to what the payer pays": "পেমেন্টকারীর অংকে যোগ হয়",
    "Address": "ঠিকানা",
    "Addresses": "ঠিকানা",
    "After fee": "ফি বাদে",
    "Alerts": "সতর্কবার্তা",
    "All": "সব",
    "All applications": "সব আবেদন",
    "All payments": "সব পেমেন্ট",
    "All payouts": "সব পেআউট",
    "All settled payments": "সব সম্পন্ন পেমেন্ট",
    "All time, CPAY's fee on settled payments": "শুরু থেকে, সম্পন্ন পেমেন্টে CPAY-এর ফি",
    "All time, paid by customers": "শুরু থেকে, গ্রাহকরা যা দিয়েছেন",
    "Amount": "পরিমাণ",
    "Amount (USD)": "পরিমাণ (USD)",
    "Amount (sats)": "পরিমাণ (sats)",
    "Applicant": "আবেদনকারী",
    "Apply": "প্রয়োগ করুন",
    "Approve": "অনুমোদন",
    "Approved": "অনুমোদিত",
    "Arrives": "পৌঁছায়",
    "Arrives in seconds. Small Lightning network fee.": "কয়েক সেকেন্ডে পৌঁছায়। সামান্য Lightning নেটওয়ার্ক ফি।",
    "At least (1% slippage)": "কমপক্ষে (১% পার্থক্য ধরে)",
    "Audit log": "অডিট লগ",
    "Authenticator": "অথেনটিকেটর",
    "Authenticator removed": "Authenticator সরানো হয়েছে",
    "Auto-withdraw threshold (USD)": "স্বয়ংক্রিয় উত্তোলনের সীমা (USD)",
    "Available": "ব্যবহারযোগ্য",
    "Available balance": "ব্যবহারযোগ্য ব্যালেন্স",
    "Balance minus what freelancers are owed": "ব্যালেন্স থেকে ফ্রিল্যান্সারদের পাওনা বাদে",
    "Bio": "পরিচিতি",
    "Business day": "ব্যবসায়িক দিন",
    "CPAY balance": "CPAY ব্যালেন্স",
    "CPAY receives each payment, keeps its fee and sends the rest to this Lightning address right away. Nothing is kept in a CPAY balance once an address is in use.": "CPAY প্রতিটি পেমেন্ট নেয়, ফি রাখে এবং বাকিটা সঙ্গে সঙ্গে এই Lightning address-এ পাঠায়। ঠিকানা চালু থাকলে CPAY ব্যালেন্সে কিছু রাখা হয় না।",
    "Can payments and payouts run right now?": "এখন কি পেমেন্ট ও পেআউট চলতে পারবে?",
    "Cash App and other Lightning wallets": "Cash App ও অন্যান্য Lightning ওয়ালেট",
    "Cash App only": "শুধু Cash App",
    "Changing this asks you to sign in again. It is used right away, and you get a notice in your inbox.": "এটি বদলাতে আবার সাইন-ইন করতে হয়। সঙ্গে সঙ্গে কাজ করে এবং আপনার ইনবক্সে নোটিশ আসে।",
    "Check address": "ঠিকানা যাচাই করুন",
    "Checking with your wallet provider…": "আপনার ওয়ালেট প্রোভাইডারের সাথে যাচাই হচ্ছে…",
    "Clear": "মুছুন",
    "Clear history": "ইতিহাস মুছুন",
    "Clear this entire conversation?": "পুরো কথোপকথন মুছবেন?",
    "Coin and network": "কয়েন ও নেটওয়ার্ক",
    "Confirm it is you": "নিশ্চিত করুন এটি আপনি",
    "Confirm send": "পাঠানো নিশ্চিত করুন",
    "Confirm withdrawal": "উত্তোলন নিশ্চিত করুন",
    "Continue": "চালিয়ে যান",
    "Conversation": "কথোপকথন",
    "Conversation cleared": "কথোপকথন মুছে ফেলা হয়েছে",
    "Copied": "কপি হয়েছে",
    "Copy": "কপি",
    "Copy invoice": "ইনভয়েস কপি করুন",
    "Copy link": "লিংক কপি করুন",
    "Could not copy": "কপি করা যায়নি",
    "Could not load": "লোড করা যায়নি",
    "Could not remove the authenticator. Sign in again and retry.": "Authenticator সরানো যায়নি। আবার সাইন-ইন করে চেষ্টা করুন।",
    "Could not remove the passkey. Sign in again and retry.": "Passkey সরানো যায়নি। আবার সাইন-ইন করে চেষ্টা করুন।",
    "Create invoice": "ইনভয়েস তৈরি করুন",
    "Create link": "লিংক তৈরি করুন",
    "Database, traffic and queues. Read only.": "ডাটাবেস, ট্রাফিক ও কিউ। শুধু দেখা যায়।",
    "Day": "দিন",
    "Default fee saved": "ডিফল্ট ফি সংরক্ষিত",
    "Default withdrawal fee %": "ডিফল্ট উত্তোলন ফি %",
    "Default withdrawal fee saved": "ডিফল্ট উত্তোলন ফি সংরক্ষিত",
    "Defaults": "ডিফল্ট",
    "Design": "ডিজাইন",
    "Desk": "ডেস্ক",
    "Destination": "গন্তব্য",
    "Destination address": "গন্তব্যের ঠিকানা",
    "Detail": "বিস্তারিত",
    "Details": "বিস্তারিত",
    "Direct payments": "সরাসরি পেমেন্ট",
    "Direct payments are paused by CPAY. Your direct links are not taking payments.": "CPAY সরাসরি পেমেন্ট সাময়িক বন্ধ রেখেছে। আপনার সরাসরি লিংকে এখন পেমেন্ট নেওয়া হচ্ছে না।",
    "Direct payments are turned off for this account. Contact support.": "এই অ্যাকাউন্টে সরাসরি পেমেন্ট বন্ধ। সাপোর্টে যোগাযোগ করুন।",
    "Dismiss": "বন্ধ করুন",
    "Display name": "প্রদর্শিত নাম",
    "Earned": "আয়",
    "Earned on settled volume": "সম্পন্ন লেনদেনে আয়",
    "Earnings": "আয়",
    "Each day's figures lock at midnight Dhaka time (UTC+6).": "প্রতিদিনের হিসাব ঢাকা সময় রাত ১২টায় (UTC+6) বন্ধ হয়।",
    "Enter 0 to 100, or leave empty": "০ থেকে ১০০ লিখুন, অথবা খালি রাখুন",
    "Enter a name": "একটি নাম লিখুন",
    "Enter the 6 digits shown in the app.": "অ্যাপে দেখানো ৬ অঙ্ক লিখুন।",
    "Enter the 6 digits shown in your authenticator app.": "আপনার authenticator অ্যাপে দেখানো ৬ অঙ্ক লিখুন।",
    "Enter the USDT address": "USDT ঠিকানা লিখুন",
    "Enter your authentication code": "আপনার যাচাই কোড লিখুন",
    "Everyone": "সবাই",
    "Expired": "মেয়াদ শেষ",
    "Failed": "ব্যর্থ",
    "Fee": "ফি",
    "Fee details": "ফির বিস্তারিত",
    "Fee saved": "ফি সংরক্ষিত",
    "Fees": "ফি",
    "Filled in from your CPAY Wallet. Tap \"Check address\", then save it.": "আপনার CPAY Wallet থেকে পূরণ করা হয়েছে। \"ঠিকানা যাচাই করুন\" চাপুন, তারপর সংরক্ষণ করুন।",
    "Filter saved": "ফিল্টার সংরক্ষিত",
    "First seen": "প্রথম দেখা",
    "Freelancers by business day": "ব্যবসায়িক দিন অনুযায়ী ফ্রিল্যান্সার",
    "Freelancers who can sign in": "যে ফ্রিল্যান্সাররা সাইন-ইন করতে পারেন",
    "Get paid straight to your own wallet": "সরাসরি নিজের ওয়ালেটে টাকা নিন",
    "Get quote": "কোট নিন",
    "Held by CPAY, ready to withdraw": "CPAY-এর কাছে, উত্তোলনের জন্য প্রস্তুত",
    "Held by CPAY, withdrawn as USDT": "CPAY-এর কাছে, USDT হিসেবে উত্তোলন হয়",
    "Hide small payments": "ছোট পেমেন্ট লুকান",
    "History": "ইতিহাস",
    "Hold": "আটকে রাখুন",
    "Host": "হোস্ট",
    "Invalid": "অবৈধ",
    "Invoice": "ইনভয়েস",
    "Invoice copied": "ইনভয়েস কপি হয়েছে",
    "Invoice page design": "ইনভয়েস পাতার ডিজাইন",
    "Issue": "সমস্যা",
    "Level": "স্তর",
    "Lightning address": "Lightning ঠিকানা",
    "Link": "লিংক",
    "Link copied": "লিংক কপি হয়েছে",
    "Link cost": "লিংক খরচ",
    "Link cost %": "লিংক খরচ %",
    "Link limit": "লিংক সীমা",
    "Link limit saved": "লিংক সীমা সংরক্ষিত",
    "Link ready": "লিংক প্রস্তুত",
    "Loading links…": "লিংক লোড হচ্ছে…",
    "Loading networks…": "নেটওয়ার্ক লোড হচ্ছে…",
    "Loading wallet…": "ওয়ালেট লোড হচ্ছে…",
    "Mark paid": "পরিশোধিত চিহ্নিত করুন",
    "Mark settled": "সম্পন্ন চিহ্নিত করুন",
    "Marked paid": "পরিশোধিত চিহ্নিত",
    "Marked settled": "সম্পন্ন চিহ্নিত",
    "Memo": "নোট",
    "Messages with the admin": "অ্যাডমিনের সাথে বার্তা",
    "Method": "পদ্ধতি",
    "Move to balance": "ব্যালেন্সে নিন",
    "My CPAY balance": "আমার CPAY ব্যালেন্স",
    "Network": "নেটওয়ার্ক",
    "Network fee": "নেটওয়ার্ক ফি",
    "New": "নতুন",
    "New accounts to review": "যাচাইয়ের অপেক্ষায় নতুন অ্যাকাউন্ট",
    "New payment link": "নতুন পেমেন্ট লিংক",
    "Newer": "নতুনগুলো",
    "No Lightning address yet.": "এখনো কোনো Lightning address নেই।",
    "No accounts": "কোনো অ্যাকাউন্ট নেই",
    "No activity": "কোনো কার্যক্রম নেই",
    "No alerts": "কোনো সতর্কবার্তা নেই",
    "No applications waiting": "কোনো আবেদন অপেক্ষায় নেই",
    "No audit rows": "কোনো অডিট এন্ট্রি নেই",
    "No data": "কোনো তথ্য নেই",
    "No days yet": "এখনো কোনো দিন নেই",
    "No domains": "কোনো ডোমেইন নেই",
    "No forwards yet": "এখনো কোনো ফরোয়ার্ড নেই",
    "No links that day": "সেদিন কোনো লিংক নেই",
    "No messages yet": "এখনো কোনো বার্তা নেই",
    "No payment links": "কোনো পেমেন্ট লিংক নেই",
    "No payments yet": "এখনো কোনো পেমেন্ট নেই",
    "No wallet": "কোনো ওয়ালেট নেই",
    "No withdrawals": "কোনো উত্তোলন নেই",
    "None yet": "এখনো কিছু নেই",
    "Not registered": "নিবন্ধিত নয়",
    "Note": "নোট",
    "Older": "পুরোনোগুলো",
    "One address per network. New payments go here automatically if you have no Lightning address. Saving or changing an address asks you to sign in again; it works right away and you get a notice in your inbox.": "প্রতি নেটওয়ার্কে একটি ঠিকানা। Lightning ঠিকানা না থাকলে নতুন পেমেন্ট স্বয়ংক্রিয়ভাবে এখানে আসে। ঠিকানা সংরক্ষণ বা বদলাতে আবার সাইন-ইন লাগে; সঙ্গে সঙ্গে কাজ করে এবং ইনবক্সে নোটিশ আসে।",
    "Open public store": "পাবলিক স্টোর খুলুন",
    "Open wallet": "ওয়ালেট খুলুন",
    "Owed to freelancers": "ফ্রিল্যান্সারদের পাওনা",
    "Owner": "মালিক",
    "Paid": "পরিশোধিত",
    "Paid out": "পরিশোধ হয়েছে",
    "Paid straight to your own wallet. Not part of your CPAY balance, and not withdrawable here: the money is already in your wallet.": "সরাসরি আপনার ওয়ালেটে দেওয়া হয়েছে। এটি CPAY ব্যালেন্সের অংশ নয় এবং এখানে উত্তোলন করা যায় না: টাকা আগেই আপনার ওয়ালেটে।",
    "Paid to": "যাকে দেওয়া হয়েছে",
    "Passkey added. You can now sign in with it.": "Passkey যোগ হয়েছে। এখন এটি দিয়ে সাইন-ইন করতে পারবেন।",
    "Passkey removed": "Passkey সরানো হয়েছে",
    "Password": "পাসওয়ার্ড",
    "Pay to CPAY balance": "CPAY ব্যালেন্সে পেমেন্ট",
    "Pay to my wallet": "আমার ওয়ালেটে পেমেন্ট",
    "Payers open your link and pay over Lightning. Settled amounts land in your USD book.": "পেমেন্টকারী আপনার লিংক খুলে Lightning দিয়ে পেমেন্ট করেন। সম্পন্ন অংক আপনার USD হিসাবে যোগ হয়।",
    "Payment": "পেমেন্ট",
    "Payment history": "পেমেন্টের ইতিহাস",
    "Payment page design": "পেমেন্ট পাতার ডিজাইন",
    "Payments go to": "পেমেন্ট যায়",
    "Payout settings saved": "পেআউট সেটিংস সংরক্ষিত",
    "Pays": "পেমেন্ট সংখ্যা",
    "Pending": "অপেক্ষমাণ",
    "Pending payouts": "অপেক্ষমাণ পেআউট",
    "Pick a network and enter an address and amount.": "নেটওয়ার্ক বাছুন, ঠিকানা ও পরিমাণ লিখুন।",
    "Platform fee %": "প্ল্যাটফর্ম ফি %",
    "Platform fee on payments": "পেমেন্টে প্ল্যাটফর্ম ফি",
    "Platform fees": "প্ল্যাটফর্ম ফি",
    "Preferred network": "পছন্দের নেটওয়ার্ক",
    "Preview all designs": "সব ডিজাইন দেখুন",
    "Preview fee": "ফি দেখুন",
    "Processing": "প্রক্রিয়াধীন",
    "Provider fee": "প্রোভাইডার ফি",
    "Public profile": "পাবলিক প্রোফাইল",
    "QR code could not load. Copy the invoice instead.": "QR কোড লোড হয়নি। এর বদলে ইনভয়েস কপি করুন।",
    "Questions about your account, payments or withdrawals.": "আপনার অ্যাকাউন্ট, পেমেন্ট বা উত্তোলন নিয়ে প্রশ্ন।",
    "Queue a payout when the balance reaches the threshold": "ব্যালেন্স সীমায় পৌঁছালে পেআউট সারিতে দিন",
    "Quote": "কোট",
    "Quote first, then confirm. The fee and the amount you receive are shown before you send.": "আগে কোট নিন, তারপর নিশ্চিত করুন। পাঠানোর আগে ফি ও আপনি কত পাবেন দেখানো হয়।",
    "Ready": "প্রস্তুত",
    "Receipt": "রসিদ",
    "Receive": "গ্রহণ",
    "Received sats": "প্রাপ্ত sats",
    "Receives": "পান",
    "Recent payments": "সাম্প্রতিক পেমেন্ট",
    "Reject": "বাতিল করুন",
    "Rejected": "বাতিল",
    "Remove address": "ঠিকানা সরান",
    "Removed. Direct links are not taking payments.": "সরানো হয়েছে। সরাসরি লিংকে এখন পেমেন্ট নেওয়া হচ্ছে না।",
    "Requested": "অনুরোধ করা হয়েছে",
    "Resolve": "সমাধান করুন",
    "Retry": "আবার চেষ্টা",
    "Review": "যাচাই",
    "Role": "ভূমিকা",
    "Route": "রুট",
    "Route and network fee": "রুট ও নেটওয়ার্ক ফি",
    "Route fee": "রুট ফি",
    "Runbook": "নির্দেশিকা",
    "Save a USDT address in Profile first. Withdrawals only go to a saved address.": "আগে প্রোফাইলে একটি USDT ঠিকানা সংরক্ষণ করুন। উত্তোলন শুধু সংরক্ষিত ঠিকানায় যায়।",
    "Save address": "ঠিকানা সংরক্ষণ করুন",
    "Save choice": "পছন্দ সংরক্ষণ করুন",
    "Save payout settings": "পেআউট সেটিংস সংরক্ষণ করুন",
    "Save platform fee": "প্ল্যাটফর্ম ফি সংরক্ষণ করুন",
    "Save profile": "প্রোফাইল সংরক্ষণ করুন",
    "Save withdrawal fee": "উত্তোলন ফি সংরক্ষণ করুন",
    "Search audit": "অডিট খুঁজুন",
    "Select a day to see each link.": "প্রতিটি লিংক দেখতে একটি দিন বাছুন।",
    "Select a freelancer above": "উপরে একজন ফ্রিল্যান্সার বাছুন",
    "Select a freelancer first": "আগে একজন ফ্রিল্যান্সার বাছুন",
    "Select a row to see that person's links.": "সেই ব্যক্তির লিংক দেখতে একটি সারি বাছুন।",
    "Select freelancer": "ফ্রিল্যান্সার বাছুন",
    "Send": "পাঠান",
    "Send USDT from platform wallet": "প্ল্যাটফর্ম ওয়ালেট থেকে USDT পাঠান",
    "Send my money to": "আমার টাকা পাঠান",
    "Sending": "পাঠানো হচ্ছে",
    "Sent": "পাঠানো হয়েছে",
    "Sent. USDT is on its way.": "পাঠানো হয়েছে। USDT পথে আছে।",
    "Settled": "সম্পন্ন",
    "Settled on your links": "আপনার লিংকে সম্পন্ন",
    "Settled payments": "সম্পন্ন পেমেন্ট",
    "Settled volume": "সম্পন্ন লেনদেন",
    "Share a link; payers choose an amount and pay a Lightning invoice.": "একটি লিংক শেয়ার করুন; পেমেন্টকারী অংক বেছে Lightning ইনভয়েসে পেমেন্ট করেন।",
    "Show": "দেখান",
    "Shown in the quote": "কোটে দেখানো হয়",
    "Skip to desk": "ডেস্কে যান",
    "Small payments": "ছোট পেমেন্ট",
    "Spendable": "খরচযোগ্য",
    "Store address": "স্টোরের ঠিকানা",
    "Storefront settings for your public page. Display name is what payers see.": "আপনার পাবলিক পাতার স্টোর সেটিংস। পেমেন্টকারীরা প্রদর্শিত নামটি দেখেন।",
    "Straight to my wallet": "সরাসরি আমার ওয়ালেটে",
    "Sum of freelancer available balances.": "ফ্রিল্যান্সারদের ব্যবহারযোগ্য ব্যালেন্সের যোগফল।",
    "Suspended": "স্থগিত",
    "The withdrawal failed and the amount is back in your balance.": "উত্তোলন ব্যর্থ হয়েছে, টাকা আপনার ব্যালেন্সে ফিরে এসেছে।",
    "Theme": "থিম",
    "This account role is not supported. Contact support.": "এই ধরনের অ্যাকাউন্ট সমর্থিত নয়। সাপোর্টে যোগাযোগ করুন।",
    "Title": "শিরোনাম",
    "Today": "আজ",
    "Today closes at midnight Bangladesh time": "আজকের হিসাব বাংলাদেশ সময় রাত ১২টায় বন্ধ হবে",
    "Today's business day": "আজকের ব্যবসায়িক দিন",
    "Toggle saved": "সংরক্ষিত",
    "Total": "মোট",
    "Tries": "চেষ্টা",
    "Try again": "আবার চেষ্টা করুন",
    "Turn off for everyone": "সবার জন্য বন্ধ করুন",
    "Turn on for everyone": "সবার জন্য চালু করুন",
    "Two-step sign-in is on for this authenticator": "এই authenticator-এ দুই ধাপের সাইন-ইন চালু",
    "Type": "ধরন",
    "USDT address": "USDT ঠিকানা",
    "USDT address saved": "USDT ঠিকানা সংরক্ষিত",
    "USDT address to use": "যে USDT ঠিকানা ব্যবহার হবে",
    "USDT addresses": "USDT ঠিকানা",
    "USDT balance": "USDT ব্যালেন্স",
    "USDT network": "USDT নেটওয়ার্ক",
    "Updated": "আপডেট হয়েছে",
    "Use a passkey": "Passkey ব্যবহার করুন",
    "Use the Lightning address of a wallet you control. CPAY checks that the wallet provider can confirm payments before you can save it. Payers see this address on the payment page. Saving or changing it asks you to sign in again, and it is used right away. You get a notice in your inbox each time it changes.": "আপনার নিয়ন্ত্রণে থাকা ওয়ালেটের Lightning address দিন। সংরক্ষণের আগে CPAY যাচাই করে যে ওয়ালেট প্রোভাইডার পেমেন্ট নিশ্চিত করতে পারে। পেমেন্টকারীরা পেমেন্ট পাতায় এই ঠিকানা দেখেন। সংরক্ষণ বা বদলাতে আবার সাইন-ইন লাগে। প্রতিবার বদলালে ইনবক্সে নোটিশ আসে।",
    "User": "ব্যবহারকারী",
    "View all": "সব দেখুন",
    "Waiting applications": "অপেক্ষমাণ আবেদন",
    "Waiting to be sent or reviewed": "পাঠানো বা যাচাইয়ের অপেক্ষায়",
    "Wallet address": "ওয়ালেট ঠিকানা",
    "Wallet balance": "ওয়ালেট ব্যালেন্স",
    "Wallet link saved": "ওয়ালেট লিংক সংরক্ষিত",
    "Wallets": "ওয়ালেট",
    "Where CPAY sends your payments": "CPAY আপনার পেমেন্ট কোথায় পাঠায়",
    "Where payments go": "পেমেন্ট কোথায় যায়",
    "Where to receive": "কোথায় টাকা পাবেন",
    "CPAY receives each payment, keeps its fee and sends the rest straight to your saved address.": "CPAY প্রতিটি পেমেন্ট নেয়, তার ফি রাখে এবং বাকি টাকা সরাসরি আপনার সংরক্ষিত ঠিকানায় পাঠায়।",
    "Save a USDT address below or a Lightning address. If you save both, Lightning is used.": "নিচে একটি USDT ঠিকানা বা একটি Lightning ঠিকানা সংরক্ষণ করুন। দুটোই থাকলে Lightning ব্যবহার হয়।",
    "Payments go to:": "পেমেন্ট যাবে:",
    "No address yet. Save a USDT or Lightning address to start receiving payments.": "এখনো কোনো ঠিকানা নেই। পেমেন্ট পেতে একটি USDT বা Lightning ঠিকানা সংরক্ষণ করুন।",
    "Who can pay": "কে পেমেন্ট করতে পারবে",
    "With direct payments, payers pay your own Lightning wallet. The money goes straight there: CPAY never holds it, cannot withdraw, refund or move it, and it is not part of your CPAY balance.": "সরাসরি পেমেন্টে পেমেন্টকারী আপনার নিজের Lightning ওয়ালেটে পেমেন্ট করেন। টাকা সোজা সেখানে যায়: CPAY কখনো টাকা ধরে না, তুলতে, ফেরত দিতে বা সরাতে পারে না, এবং এটি আপনার CPAY ব্যালেন্সের অংশ নয়।",
    "Withdraw USDT": "USDT উত্তোলন",
    "Withdraw fee": "উত্তোলন ফি",
    "Withdraw stablecoin": "স্টেবলকয়েন উত্তোলন",
    "Withdrawal fee (Balance mode only)": "উত্তোলন ফি (শুধু ব্যালেন্স মোডে)",
    "Withdrawal fee revenue": "উত্তোলন ফি থেকে আয়",
    "Withdrawal history": "উত্তোলনের ইতিহাস",
    "Withdrawals marked paid": "পরিশোধিত চিহ্নিত উত্তোলন",
    "Write a message first": "আগে একটি বার্তা লিখুন",
    "You receive": "আপনি পাবেন",
    "You send": "আপনি পাঠাবেন",
    "Your links": "আপনার লিংক",
    "in use": "চালু",
    "no payments": "কোনো পেমেন্ট নেই",
    "none": "কিছু নেই",
    "waiting": "অপেক্ষায়",
    "— Choose a freelancer —": "— একজন ফ্রিল্যান্সার বাছুন —",
    "withdrawal fee, small payments, flags, alerts, instant-forward limits, old switches": "উত্তোলন ফি, ছোট পেমেন্ট, ফ্ল্যাগ, সতর্কবার্তা, তাৎক্ষণিক ফরোয়ার্ড সীমা, পুরোনো সুইচ",
    'Support email': 'সাপোর্ট ইমেইল', 'CPAY Wallet address (https)': 'CPAY Wallet-এর ঠিকানা (https)', 'Settings sections': 'সেটিংসের অংশ',
    // Admin → System guide
    "12:00 AM to 12:00 AM": "রাত ১২টা থেকে রাত ১২টা",
    "Each bar is one Bangladesh calendar day, midnight to midnight.": "প্রতিটা বার বাংলাদেশের এক দিন, রাত ১২টা থেকে রাত ১২টা।",
    "System guide (সিস্টেম গাইড)": "সিস্টেম গাইড",
    // Locations, payment details and the overview (20261020090000)
    "Your location": "আপনার অবস্থান",
    "Optional. Helps CPAY support you in your area. Only you and CPAY admins see it. Not shown to payers.": "ঐচ্ছিক। আপনার এলাকায় CPAY-কে সহায়তা দিতে সাহায্য করে। শুধু আপনি আর CPAY অ্যাডমিন এটি দেখেন। পেমেন্টকারীরা দেখেন না।",
    "Country": "দেশ",
    "Division / state": "বিভাগ / রাজ্য",
    "District / city": "জেলা / শহর",
    "Area": "এলাকা",
    "Not set": "দেওয়া হয়নি",
    "Save location": "অবস্থান সংরক্ষণ করুন",
    "Location saved": "অবস্থান সংরক্ষিত হয়েছে",
    "Payment details": "পেমেন্টের বিস্তারিত",
    "Amount paid": "পরিশোধিত পরিমাণ",
    "Created": "তৈরি",
    "Payer location": "পেমেন্টকারীর অবস্থান",
    "Unknown": "অজানা",
    "Forward": "ফরোয়ার্ড",
    "Reference": "রেফারেন্স",
    "Payer location is approximate (country, region, city from the connection). CPAY does not record exact positions.": "পেমেন্টকারীর অবস্থান আনুমানিক (সংযোগ থেকে দেশ, অঞ্চল, শহর)। CPAY সঠিক অবস্থান রেকর্ড করে না।",
    "This payment is not available.": "এই পেমেন্টটি পাওয়া যাচ্ছে না।",
    "Tap a payment to see its details.": "বিস্তারিত দেখতে একটি পেমেন্টে চাপুন।",
    "Show details": "বিস্তারিত দেখুন",
    "Country code": "দেশের কোড",
    "Payments from the last": "যত দিনের পেমেন্ট",
    "Payments by area": "এলাকা অনুযায়ী পেমেন্ট",
    "Users by area": "এলাকা অনুযায়ী ব্যবহারকারী",
    "Region / city": "অঞ্চল / শহর",
    "Division": "বিভাগ",
    "District": "জেলা",
    "Settled USD": "সম্পন্ন USD",
    "Location (set by user)": "অবস্থান (ব্যবহারকারীর দেওয়া)",
    "Last seen": "শেষ দেখা",
    "No payments in this range": "এই সময়ে কোনো পেমেন্ট নেই",
    "No user has set a location": "কোনো ব্যবহারকারী অবস্থান দেননি",
    "None": "কিছু নেই",
    "Division, district, city or area": "বিভাগ, জেলা, শহর বা এলাকা",
    "Approximate only: payer country, region and city from the connection when the payment was created; the location each user set; the country each user last opened their desk from. No IP addresses or GPS positions are stored.": "শুধু আনুমানিক: পেমেন্ট তৈরির সময় সংযোগ থেকে পেমেন্টকারীর দেশ, অঞ্চল ও শহর; প্রতিটি ব্যবহারকারীর দেওয়া অবস্থান; প্রতিটি ব্যবহারকারী শেষবার যে দেশ থেকে ডেস্ক খুলেছেন। কোনো IP ঠিকানা বা GPS অবস্থান রাখা হয় না।",
    "Waiting to send": "পাঠানোর অপেক্ষায়",
    "Sent to you": "আপনাকে পাঠানো হয়েছে",
    "Retrying": "আবার চেষ্টা হচ্ছে",
    "Held, owed to you": "আটকে আছে, আপনার পাওনা",
    "Not forwarded": "ফরোয়ার্ড হয়নি",
    "All time, CPAY's fee on settled payments": "সব সময়ের, সম্পন্ন পেমেন্টে CPAY-এর ফি",
    "7 days": "৭ দিন",
    "30 days": "৩০ দিন",
    "90 days": "৯০ দিন",
    "Auto withdraw": "স্বয়ংক্রিয় উত্তোলন",
    "Auto withdraw:": "স্বয়ংক্রিয় উত্তোলন:",
    "Auto withdraw: On": "স্বয়ংক্রিয় উত্তোলন: চালু",
    "Auto withdraw: Off": "স্বয়ংক্রিয় উত্তোলন: বন্ধ",
    "Auto withdraw is": "স্বয়ংক্রিয় উত্তোলন এখন",
    "for everyone who has no setting of their own.": "যাঁদের নিজস্ব সেটিং নেই, তাঁদের সবার জন্য।",
    "On: after the platform fee, each payment is sent by itself to the user’s saved Lightning or USDT address.": "চালু: প্ল্যাটফর্ম ফি কাটার পর প্রতিটি পেমেন্ট নিজে থেকেই ব্যবহারকারীর সংরক্ষিত Lightning বা USDT ঠিকানায় চলে যায়।",
    "Off: the amount is added to the user’s balance. The user withdraws by hand from Withdraw.": "বন্ধ: টাকা ব্যবহারকারীর ব্যালেন্সে জমা হয়। ব্যবহারকারী উত্তোলন পাতা থেকে নিজে তুলে নেন।",
    "To set one user differently, open Manage users and use Auto withdraw on that row.": "কোনো একজন ব্যবহারকারীর জন্য আলাদা করতে ব্যবহারকারী পরিচালনা খুলে তাঁর সারিতে স্বয়ংক্রিয় উত্তোলন চাপুন।",
    "Auto withdraw off (balance)": "স্বয়ংক্রিয় উত্তোলন বন্ধ (ব্যালেন্স)",
    "Auto withdraw on (instant forward)": "স্বয়ংক্রিয় উত্তোলন চালু (তাৎক্ষণিক ফরোয়ার্ড)",
    "Default": "ডিফল্ট",
    "Default (follow Settings)": "ডিফল্ট (সেটিংস অনুযায়ী)",
    "On: send each payment to their saved address": "চালু: প্রতিটি পেমেন্ট তাঁর সংরক্ষিত ঠিকানায় পাঠান",
    "Off: add payments to their balance": "বন্ধ: পেমেন্ট তাঁর ব্যালেন্সে জমা করুন",
    "Turning it off moves sends that are still waiting back into their balance.": "বন্ধ করলে যে পাঠানোগুলো এখনও অপেক্ষায় আছে সেগুলো তাঁর ব্যালেন্সে ফিরে যায়।",
    "Auto withdraw saved": "স্বয়ংক্রিয় উত্তোলন সংরক্ষিত",
    "(set for your account by the admin)": "(অ্যাডমিন আপনার অ্যাকাউন্টের জন্য ঠিক করেছেন)",
    "CPAY receives each payment, keeps its fee and adds the rest to your balance. You withdraw when you like.": "CPAY প্রতিটি পেমেন্ট নেয়, ফি রাখে এবং বাকিটা আপনার ব্যালেন্সে জমা করে। আপনি যখন খুশি তুলতে পারেন।",
    "Payments are added to your CPAY balance. Open Withdraw to send money to your Lightning or USDT address.": "পেমেন্ট আপনার CPAY ব্যালেন্সে জমা হয়। আপনার Lightning বা USDT ঠিকানায় টাকা পাঠাতে উত্তোলন খুলুন।",
    "Earlier balance, ready to withdraw": "আগের ব্যালেন্স, তোলার জন্য তৈরি",
    "New payments are added here": "নতুন পেমেন্ট এখানে জমা হয়",
    "Choose where to send, get a quote, then confirm. The fee and the amount you receive are shown before you send.": "কোথায় পাঠাবেন বেছে নিন, কোট নিন, তারপর নিশ্চিত করুন। পাঠানোর আগেই ফি আর আপনি কত পাবেন দেখানো হয়।",
    "Send to": "কোথায় পাঠাবেন",
    "Withdraw all": "সব তুলুন",
    "Bitcoin · Lightning": "বিটকয়েন · Lightning",
    "Lightning address or invoice": "Lightning ঠিকানা বা ইনভয়েস",
    "Minimum $1. Your saved Lightning address, or a Lightning invoice with an amount (the invoice amount is used).": "সর্বনিম্ন $1। আপনার সংরক্ষিত Lightning ঠিকানা, অথবা টাকার পরিমাণসহ একটি Lightning ইনভয়েস (ইনভয়েসের পরিমাণই নেওয়া হবে)।",
    "From the invoice": "ইনভয়েস থেকে",
    "Sent to your saved Lightning address, or to the Lightning invoice you paste.": "আপনার সংরক্ষিত Lightning ঠিকানায়, অথবা আপনার দেওয়া Lightning ইনভয়েসে পাঠানো হয়।",
    "Auto withdraw is on: new payments go to your saved address by themselves. Use this page for money that is still in your balance.": "স্বয়ংক্রিয় উত্তোলন চালু: নতুন পেমেন্ট নিজে থেকেই আপনার সংরক্ষিত ঠিকানায় যায়। ব্যালেন্সে যা আছে তা তুলতে এই পাতা ব্যবহার করুন।",
    "Auto withdraw is off: payments are added to your balance. Withdraw here whenever you like.": "স্বয়ংক্রিয় উত্তোলন বন্ধ: পেমেন্ট আপনার ব্যালেন্সে জমা হয়। যখন খুশি এখান থেকে তুলুন।",
    "Nothing to withdraw right now.": "এখন তোলার মতো কিছু নেই।",
    "Nothing to withdraw": "তোলার মতো কিছু নেই",
    "USDT goes only to an address saved in Profile.": "USDT শুধু প্রোফাইলে সংরক্ষিত ঠিকানায় যায়।",
    "Saved Lightning address:": "সংরক্ষিত Lightning ঠিকানা:",
    "For Lightning, paste a Lightning invoice, or save a Lightning address in Profile.": "Lightning-এর জন্য একটি Lightning ইনভয়েস দিন, অথবা প্রোফাইলে Lightning ঠিকানা সংরক্ষণ করুন।",
    "Confirmed withdrawals show up here.": "নিশ্চিত করা উত্তোলন এখানে দেখা যাবে।",
    "Finished": "শেষ হয়েছে",
    "USDT payout threshold (USD)": "USDT পেআউটের সীমা (USD)",
    "Queue a USDT payout when the balance reaches the threshold": "ব্যালেন্স সীমায় পৌঁছালে USDT পেআউট সারিতে দিন",
    "Enter your Lightning address or paste a Lightning invoice": "আপনার Lightning ঠিকানা লিখুন বা একটি Lightning ইনভয়েস দিন",
    "Minimum Lightning withdrawal is $1": "Lightning-এ সর্বনিম্ন উত্তোলন $1",
    "Enter an amount": "পরিমাণ লিখুন",
    "Sent. The Lightning payment is on its way.": "পাঠানো হয়েছে। Lightning পেমেন্ট পথে আছে।",
    "365 days": "৩৬৫ দিন"
  };
  const KEY = 'cpay-lang';
  let lang = 'en';
  try { lang = localStorage.getItem(KEY) === 'bn' ? 'bn' : 'en'; } catch { /* private mode */ }

  const original = new WeakMap();      // Text node -> its English text
  const attrs = ['aria-label', 'placeholder', 'title'];
  const SKIP = 'script,style,textarea,code,.mono,[data-no-i18n],[contenteditable]';
  let applying = false;

  function t(en) { return lang === 'bn' && BN[en] ? BN[en] : en; }

  // Bangla text copied as-is from a translated node (the top bar title
  // copies the active menu label) goes back to English on a switch.
  const EN_OF = Object.fromEntries(Object.entries(BN).map(([en, bn]) => [bn, en]));
  const bnOf = (en) => { const k = en.trim(); return BN[k] ? en.replace(k, BN[k]) : en; };

  function textNode(n) {
    const p = n.parentElement;
    if (!p || p.closest(SKIP)) return;
    let en = original.get(n);
    // A script replaced the text since we translated it: that is the new English.
    if (en !== undefined && n.nodeValue !== en && n.nodeValue !== bnOf(en)) { original.delete(n); en = undefined; }
    if (en === undefined) {
      const cur = n.nodeValue, k = cur.trim();
      en = EN_OF[k] ? cur.replace(k, EN_OF[k]) : cur;
    }
    const key = en.trim();
    if (!key || !BN[key]) return;
    original.set(n, en);
    const want = lang === 'bn' ? bnOf(en) : en;
    if (n.nodeValue !== want) n.nodeValue = want;
  }
  function element(el) {
    if (el.closest(SKIP)) return;
    for (const a of attrs) {
      const store = `i18nEn${a.replace(/-(\w)/g, (_, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase())}`;
      const cur = el.getAttribute(a);
      if (cur == null && el.dataset[store] == null) continue;
      const en = el.dataset[store] ?? cur;
      if (!BN[en.trim()]) continue;
      el.dataset[store] = en;
      const want = lang === 'bn' ? BN[en.trim()] : en;
      if (cur !== want) el.setAttribute(a, want);
    }
  }
  function apply(root) {
    if (!root) return;
    applying = true;
    try {
      if (root.nodeType === 3) { textNode(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 9) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) textNode(n);
      if (root.nodeType === 1) element(root);
      root.querySelectorAll?.('[aria-label],[placeholder],[title]').forEach(element);
    } finally { applying = false; }
  }

  function set(next) {
    lang = next === 'bn' ? 'bn' : 'en';
    try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
    document.documentElement.lang = lang;
    apply(document.body);
    paintSwitch();
    document.dispatchEvent(new CustomEvent('cpay:lang', { detail: { lang } }));
  }

  let button = null;
  function paintSwitch() {
    if (!button) return;
    button.textContent = lang === 'bn' ? 'English' : 'বাংলা';
    button.setAttribute('aria-label', lang === 'bn' ? 'Switch to English' : 'বাংলায় দেখুন');
    button.setAttribute('lang', lang === 'bn' ? 'en' : 'bn');
  }
  function addSwitch() {
    const top = document.querySelector('.app-top');
    if (!top || top.querySelector('.lang-switch')) return;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost sm lang-switch';
    button.dataset.noI18n = '';
    button.onclick = () => set(lang === 'bn' ? 'en' : 'bn');
    const chip = top.querySelector('.me-chip');
    top.insertBefore(button, chip || null);
    paintSwitch();
  }

  function start() {
    addSwitch();
    document.documentElement.lang = lang;
    if (lang === 'bn') apply(document.body);
    new MutationObserver((list) => {
      if (applying || lang !== 'bn') return;
      for (const m of list) {
        if (m.type === 'characterData') apply(m.target);
        else m.addedNodes.forEach((n) => apply(n));
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  window.cpayI18n = { t, set, get lang() { return lang; }, apply, phrases: BN };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
