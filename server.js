
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;

// ==========================================
// 1. Inisialisasi Variabel Global
// ==========================================
let shopeeToken = process.env.SHOPEE_TOKEN || '';
const apiKey = process.env.API_KEY || '';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatID = process.env.TELEGRAM_CHAT_ID || '';
const qrisStatic = process.env.QRIS_STATIC || '';

const qrisStore = new Map();
const usedTransactionIds = new Map();
let tokenValid = true;
let tokenNotifSent = false;
const logs = [];
const MAX_LOGS = 100;

const statusMap = {
    1: 'UNPAID',
    2: 'SUCCESS',
    3: 'EXPIRED',
    4: 'FAILED',
    5: 'REFUNDED'
};

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
];

// ==========================================
// 2. Fungsi Bantuan (Helpers)
// ==========================================
function randomUA() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function logEvent(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
    logs.push({ timestamp, level, message });
    if (logs.length > MAX_LOGS) logs.shift();
}

function getReqToken(req) {
    return req.headers['authorization'] || shopeeToken;
}

function formatTransaction(tx) {
    const wibOffset = 7 * 3600 * 1000;
    const date = new Date((tx.create_time || tx.date || 0) * 1000 + wibOffset);
    const pad = (n) => String(n).padStart(2, '0');
    
    const formattedTime = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    
    const cleanAmountStr = String(tx.amount || '0').replace(/\./g, '').replace(/,/g, '');
    const amount = parseInt(cleanAmountStr, 10) || 0;
    const status = statusMap[tx.status] || ('UNKNOWN_' + tx.status);
    
    return { amount, status, time: formattedTime };
}

// ==========================================
// 3. Modul Manipulasi QRIS (TLV Parser & Checksum)
// ==========================================
function parseTLV(qrisStr) {
    const result = [];
    let i = 0;
    while (i < qrisStr.length) {
        if (i + 4 > qrisStr.length) break;
        const tag = qrisStr.slice(i, i + 2);
        const length = parseInt(qrisStr.slice(i + 2, i + 4), 10);
        if (isNaN(length)) break;
        
        i += 4;
        if (i + length > qrisStr.length) break;
        
        const value = qrisStr.slice(i, i + length);
        i += length;
        result.push([tag, value]);
    }
    return result;
}

function buildTLV(tlvArray) {
    let result = '';
    for (const item of tlvArray) {
        const tag = item[0];
        const value = item[1];
        result += tag + String(value.length).padStart(2, '0') + value;
    }
    return result;
}

function crc16CCITT(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= (str.charCodeAt(i) << 8);
        for (let j = 0; j < 8; j++) {
            if (crc & 0x8000) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc = crc << 1;
            }
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function generateDynamicQRIS(staticQR, amount) {
    if (!staticQR) throw new Error('Konfigurasi QRIS statis belum diatur');
    
    const parsed = parseTLV(staticQR);
    const newQR = [];
    let hasAmount = false;
    
    for (const item of parsed) {
        if (item[0] === '63') continue; // Buang CRC lama
        if (item[0] === '54') {
            newQR.push(['54', String(amount)]);
            hasAmount = true;
            continue;
        }
        newQR.push(item);
    }
    
    if (!hasAmount) {
        newQR.push(['54', String(amount)]);
    }
    
    let rawString = buildTLV(newQR) + '6304';
    const crc = crc16CCITT(rawString);
    return rawString + crc;
}

// ==========================================
// 4. Modul Komunikasi Shopee API & Telegram
// ==========================================
async function sendTelegramNotif(message) {
    if (!telegramBotToken || !telegramChatID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            chat_id: telegramChatID,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 10000 });
    } catch (err) {
        console.error('Telegram Error:', err.message);
    }
}

async function callShopeeAPI(startTime, endTime, pageSize, nextPos = '', token = shopeeToken) {
    const payload = {
        data: {
            metadata: { token: token, language: 'id', timezone: 'Asia/Jakarta' },
            pageSize: pageSize,
            filter: { startTime: startTime, endTime: endTime, serviceList: [1, 3] },
            sorter: { field: 'create_time', order: 'descend' },
            next_position: nextPos
        }
    };
    const response = await axios.post('https://api.shopeepay.co.id/v2/transaction/list', payload, {
        headers: {
            'Content-Type': 'application/json',
            'Origin': 'https://shopeepay.co.id',
            'Referer': 'https://shopeepay.co.id/',
            'User-Agent': randomUA(),
            'X-Timestamp-Ms': String(Date.now())
        },
        timeout: 20000
    });
    return response.data;
}

async function callShopeeDetailAPI(orderSn, token = shopeeToken) {
    const payload = {
        data: {
            metadata: { token: token, language: 'id', timezone: 'Asia/Jakarta' },
            order_sn: orderSn
        }
    };
    const response = await axios.post('https://api.shopeepay.co.id/v2/transaction/detail', payload, {
        headers: {
            'Content-Type': 'application/json',
            'Origin': 'https://shopeepay.co.id',
            'Referer': 'https://shopeepay.co.id/',
            'User-Agent': randomUA(),
            'X-Timestamp-Ms': String(Date.now())
        },
        timeout: 20000
    });
    return response.data;
}

// Worker: Cek status token setiap 5 menit
async function checkToken() {
    const now = Math.floor(Date.now() / 1000);
    try {
        const res = await callShopeeAPI(now - 3600, now, 1, '');
        if (!res || res.code !== 0) {
            const errorMsg = res ? res.msg : 'Unknown Error';
            logEvent('WARN', 'Pengecekan token gagal: ' + errorMsg);
            tokenValid = false;
            
            if (!tokenNotifSent) {
                await sendTelegramNotif(`Token ShopeePay Anda sudah tidak valid: ${errorMsg}\n\nUpdate token via POST /update-token`);
                tokenNotifSent = true;
            }
            return;
        }
        logEvent('INFO', 'Token ShopeePay valid.');
        tokenValid = true;
        tokenNotifSent = false;
    } catch (err) {
        logEvent('ERROR', 'Token check failed: ' + err.message);
        tokenValid = false;
    }
}
function startTokenChecker() {
    checkToken();
    setInterval(checkToken, 5 * 60 * 1000);
}

// ==========================================
// 5. Middleware & Routing
// ==========================================
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

function apiKeyMiddleware(req, res, next) {
    const clientKey = req.headers['x-api-key'] || req.query['api_key'];
    if (!clientKey || clientKey !== apiKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API Key' });
    }
    next();
}

app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Server is running', timestamp: new Date().toISOString() });
});

app.post('/update-token', apiKeyMiddleware, (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token tidak boleh kosong' });
    shopeeToken = token;
    logEvent('INFO', 'Token ShopeePay diubah secara manual');
    res.json({ success: true, data: { message: 'Token berhasil diubah' } });
});

app.get('/token-status', apiKeyMiddleware, (req, res) => {
    res.json({
        success: tokenValid,
        data: { token_status: tokenValid ? 'valid' : 'invalid', message: tokenValid ? 'Token is working' : 'Token expired' }
    });
});

app.post('/create-qris', apiKeyMiddleware, (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Provide valid amount (positive integer)' });
    }
    
    try {
        const dynamicQR = generateDynamicQRIS(qrisStatic, amount);
        const qrId = crypto.randomBytes(4).toString('hex');
        const expiresAt = new Date(Date.now() + (15 * 60 * 1000));
        
        qrisStore.set(qrId, { data: dynamicQR, expiresAt });
        
        const host = req.get('host');
        const qris_url = `${req.protocol}://${host}/qr/${qrId}`;
        
        res.json({
            success: true,
            data: { qris_url, amount, expires_at: expiresAt.toISOString(), expires_in: 900 }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/qr/:id', (req, res) => {
    const id = req.params.id;
    const qrData = qrisStore.get(id);
    if (!qrData) return res.status(404).json({ success: false, error: 'QRIS not found or expired' });
    
    if (Date.now() > qrData.expiresAt.getTime()) {
        qrisStore.delete(id);
        return res.status(410).json({ success: false, error: 'QRIS expired' });
    }
    
    const deepLink = 'shopeepay://?qris=' + encodeURIComponent(qrData.data);
    res.redirect(302, deepLink);
});

app.get('/transactions', apiKeyMiddleware, async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    let startTime = parseInt(req.query.startTime, 10);
    let endTime = parseInt(req.query.endTime, 10);
    let pageSize = parseInt(req.query.pageSize, 10);
    const nextPos = req.query.nextPos || '';
    
    if (isNaN(startTime) || startTime === 0) startTime = now - (3 * 24 * 3600);
    if (isNaN(endTime) || endTime === 0) endTime = now;
    if (isNaN(pageSize) || pageSize <= 0) pageSize = 10;
    
    const token = getReqToken(req);
    try {
        const shopeeRes = await callShopeeAPI(startTime, endTime, pageSize, nextPos, token);
        if (!shopeeRes) return res.status(500).json({ success: false, error: 'Empty response from ShopeePay API' });
        if (shopeeRes.code !== 0) return res.status(400).json({ success: false, error: shopeeRes.msg || 'API error' });
        
        const txList = (shopeeRes.data && shopeeRes.data.list) || [];
        const formattedTxs = [];
        
        for (const tx of txList) {
            const fTx = formatTransaction(tx);
            formattedTxs.push(fTx);
        }
        
        res.json({
            success: true,
            total_amount: shopeeRes.data?.total_amount || '0',
            data: { transactions: formattedTxs }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/transactions/all', apiKeyMiddleware, async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - (7 * 24 * 3600); // Tarik data 7 hari terakhir
    const endTime = now;
    const pageSize = 100;
    const token = getReqToken(req);
    
    const allTxs = [];
    let nextPos = '';
    
    try {
        while (true) {
            const shopeeRes = await callShopeeAPI(startTime, endTime, pageSize, nextPos, token);
            if (!shopeeRes || shopeeRes.code !== 0) break;
            
            const list = (shopeeRes.data && shopeeRes.data.list) || [];
            for (const tx of list) {
                allTxs.push(formatTransaction(tx));
            }
            
            if (!shopeeRes.data || !shopeeRes.data.has_more || list.length < pageSize) break;
            nextPos = shopeeRes.data.next_position;
            
            // Hindari rate-limit
            await new Promise(r => setTimeout(r, 500));
        }
        
        res.json({
            success: true,
            total_amount: String(allTxs.length),
            data: { period: '7 Days', total_count: allTxs.length, transactions: allTxs }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/check-payment', apiKeyMiddleware, async (req, res) => {
    const { amount, startTime } = req.body;
    if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Provide valid amount (positive integer)' });
    }
    
    const token = getReqToken(req);
    const now = Math.floor(Date.now() / 1000);
    let sTime = parseInt(startTime, 10);
    if (isNaN(sTime) || sTime <= 0) sTime = now - (30 * 60);
    
    try {
        const shopeeRes = await callShopeeAPI(sTime, now, 50, '', token);
        if (!shopeeRes || shopeeRes.code !== 0) {
            return res.status(400).json({ success: false, error: shopeeRes?.msg || 'Shopee API Error' });
        }
        
        const list = shopeeRes.data?.list || [];
        const targetAmount = Number(amount);
        
        const matchedTx = list.find(tx => {
            const cleanAmount = parseInt(String(tx.amount || '0').replace(/\./g, '').replace(/,/g, ''), 10) || 0;
            const txId = tx.transactionId || tx.displayTransactionId;
            return cleanAmount === targetAmount && tx.status === 2 && tx.create_time >= sTime && !usedTransactionIds.has(txId);
        });
        
        if (!matchedTx) {
            return res.json({ success: true, paid: false });
        }
        
        const txId = matchedTx.transactionId || matchedTx.displayTransactionId;
        usedTransactionIds.set(txId, matchedTx.create_time);
        
        const fTx = formatTransaction(matchedTx);
        res.json({
            success: true,
            paid: true,
            transaction: {
                transactionId: txId,
                amount: fTx.amount,
                status: fTx.status,
                time: fTx.time,
                issuer: 'ShopeePay/QRIS'
            }
        });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/logs', apiKeyMiddleware, (req, res) => {
    res.json({ success: true, data: { logs } });
});

app.get('/', (req, res) => {
    res.send('Shopee API Running');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (shopeeToken && apiKey) {
        startTokenChecker();
    } else {
        console.warn('API_KEY atau SHOPEE_TOKEN belum diatur, token checker tidak dijalankan.');
    }
});
