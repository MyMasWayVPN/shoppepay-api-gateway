'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;

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

function logEvent(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
    logs.push({ timestamp, level, message });
    if (logs.length > MAX_LOGS) {
        logs.shift();
    }
}

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
];

function randomUA() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

const statusMap = {
    1: 'SUCCESS',
    2: 'PENDING',
    3: 'FAILED',
    4: 'CANCELLED',
    5: 'REFUNDED'
};

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

function apiKeyMiddleware(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== apiKey) {
        return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    }
    next();
}

function formatTransaction(txn) {
    const date = new Date(txn.create_time * 1000);
    const offset = 7 * 60;
    const localDate = new Date(date.getTime() + (offset * 60 * 1000));
    
    const pad = num => String(num).padStart(2, '0');
    const timeStr = `${localDate.getUTCFullYear()}-${pad(localDate.getUTCMonth() + 1)}-${pad(localDate.getUTCDate())} ${pad(localDate.getUTCHours())}:${pad(localDate.getUTCMinutes())}:${pad(localDate.getUTCSeconds())}`;
    
    const amountStr = String(txn.amount || '0').replace(/\./g, '').replace(/,/g, '');
    const amount = parseInt(amountStr, 10) || 0;
    const status = statusMap[txn.status] || 'UNKNOWN_' + txn.status;
    
    return { amount, status, time: timeStr };
}

function getReqToken(req) {
    return req.headers['x-shopee-token'] || shopeeToken;
}

async function callShopeeAPI(startTime, endTime, pageSize, nextPosition, token = shopeeToken) {
    const payload = {
        data: {
            metadata: { token, language: 'id', timezone: 'Asia/Jakarta' },
            pageSize,
            filter: { startTime, endTime, serviceList: [1, 3] },
            sorter: { field: 'create_time', order: 'descend' },
            next_position: nextPosition || ''
        }
    };
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://seller.shopee.co.id',
        'Referer': 'https://seller.shopee.co.id/',
        'User-Agent': randomUA(),
        'X-Timestamp-Ms': String(Date.now())
    };
    const response = await axios.post('https://seller.shopee.co.id/api/v3/finance/merchant_balance/transaction_list', payload, { headers, timeout: 20000 });
    return response.data;
}

async function callShopeeDetailAPI(orderSn, token = shopeeToken) {
    const payload = {
        data: {
            metadata: { token, language: 'id', timezone: 'Asia/Jakarta' },
            order_sn: orderSn
        }
    };
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://seller.shopee.co.id',
        'Referer': 'https://seller.shopee.co.id/',
        'User-Agent': randomUA(),
        'X-Timestamp-Ms': String(Date.now())
    };
    const response = await axios.post('https://seller.shopee.co.id/api/v3/finance/merchant_balance/transaction_detail', payload, { headers, timeout: 20000 });
    return response.data;
}

async function sendTelegramNotif(message) {
    if (!telegramBotToken || !telegramChatID) {
        console.warn('[TELEGRAM] Bot token atau chat ID belum diset');
        return;
    }
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    try {
        await axios.post(url, { chat_id: telegramChatID, text: message, parse_mode: 'HTML' }, { timeout: 10000 });
        console.log('Notifikasi Telegram terkirim');
    } catch (error) {
        console.error('Gagal mengirim notifikasi Telegram:', error.message);
    }
}

function parseTLV(qris) {
    const tags = [];
    let i = 0;
    while (i < qris.length) {
        if (i + 4 > qris.length) break;
        const tag = qris.slice(i, i + 2);
        const len = parseInt(qris.slice(i + 2, i + 4), 10);
        if (isNaN(len)) break;
        i += 4;
        if (i + len > qris.length) break;
        const value = qris.slice(i, i + len);
        i += len;
        tags.push([tag, value]);
    }
    return tags;
}

function buildTLV(tags) {
    let qris = '';
    for (const [tag, value] of tags) {
        qris += tag + String(value.length).padStart(2, '0') + value;
    }
    return qris;
}

function crc16CCITT(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc = crc << 1;
            }
            crc &= 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function generateDynamicQRIS(qrisStr, amount) {
    if (!qrisStr) throw new Error('QRIS Static belum dikonfigurasi');
    const tags = parseTLV(qrisStr);
    if (tags.length === 0) throw new Error('Format QRIS tidak valid');
    
    const newTags = [];
    let hasAmount = false;
    
    for (const tag of tags) {
        if (tag[0] === '63') continue;
        if (tag[0] === '54') {
            newTags.push(['54', String(amount)]);
            hasAmount = true;
            continue;
        }
        newTags.push(tag);
    }
    
    if (!hasAmount) {
        const finalTags = [];
        for (const tag of newTags) {
            finalTags.push(tag);
            if (tag[0] === '53') {
                finalTags.push(['54', String(amount)]);
            }
        }
        newTags.length = 0;
        newTags.push(...finalTags);
    }
    
    let newQris = buildTLV(newTags);
    newQris += '6304';
    const crc = crc16CCITT(newQris);
    return newQris + crc;
}

async function checkToken() {
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 3600;
    const endTime = now;
    try {
        const res = await callShopeeAPI(startTime, endTime, 1, '');
        if (!res || res.code !== 0) {
            const msg = res ? res.msg : 'Unknown error';
            logEvent('WARN', 'Token check failed: ' + msg);
            tokenValid = false;
            if (!tokenNotifSent) {
                await sendTelegramNotif('⚠️ <b>Token ShopeePay Invalid/Expired!</b>\n\n' + msg + '\n\nUpdate token via POST /update-token');
                tokenNotifSent = true;
            }
            return;
        }
        logEvent('INFO', 'Token check success (Valid)');
        tokenValid = true;
        tokenNotifSent = false;
    } catch (error) {
        logEvent('ERROR', 'Token check failed: ' + error.message);
        tokenValid = false;
        if (!tokenNotifSent) {
            await sendTelegramNotif('⚠️ <b>Token ShopeePay Error!</b>\n\n' + error.message + '\n\nUpdate token via POST /update-token');
            tokenNotifSent = true;
        }
    }
}

function startTokenChecker() {
    checkToken();
    setInterval(checkToken, 5 * 60 * 1000); 
}

app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Server is healthy', timestamp: new Date().toISOString() });
});

app.post('/update-token', apiKeyMiddleware, (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Provide valid token' });
    shopeeToken = token;
    logEvent('INFO', 'Token updated via API');
    res.json({ success: true, data: { message: 'Token updated successfully' } });
});

app.get('/token-status', apiKeyMiddleware, (req, res) => {
    const status = tokenValid ? 'valid' : 'invalid';
    res.json({ success: tokenValid, data: { token_status: status, message: tokenValid ? 'Token is working' : 'Token expired/invalid' } });
});

app.post('/generate-qris', apiKeyMiddleware, (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Provide valid amount (positive integer)' });
    }
    try {
        const dynamicQris = generateDynamicQRIS(qrisStatic, amount);
        const qrId = crypto.randomBytes(4).toString('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); 
        
        qrisStore.set(qrId, { data: dynamicQris, expiresAt });
        
        const host = req.get('host');
        const protocol = req.protocol;
        const qrisUrl = `${protocol}://${host}/qr/${qrId}`;
        
        const pad = num => String(num).padStart(2, '0');
        const expStr = `${expiresAt.getUTCFullYear()}-${pad(expiresAt.getUTCMonth() + 1)}-${pad(expiresAt.getUTCDate())} ${pad(expiresAt.getUTCHours())}:${pad(expiresAt.getUTCMinutes())}:${pad(expiresAt.getUTCSeconds())}`;
        
        res.json({ success: true, data: { qris_url: qrisUrl, amount, expires_at: expStr, expires_in: 900 } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/qr/:id', (req, res) => {
    const id = req.params.id;
    const qris = qrisStore.get(id);
    if (!qris) {
        return res.status(404).json({ success: false, error: 'QR Code not found or expired' });
    }
    if (Date.now() > qris.expiresAt.getTime()) {
        qrisStore.delete(id);
        return res.status(404).send('QR Code expired');
    }
    const redirectUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qris.data);
    res.redirect(302, redirectUrl);
});

app.get('/transactions', apiKeyMiddleware, async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    let startTime = parseInt(req.query.start_time, 10);
    let endTime = parseInt(req.query.end_time, 10);
    let pageSize = parseInt(req.query.limit, 10);
    const nextPos = req.query.next_position || '';
    
    if (isNaN(startTime) || startTime === 0) startTime = now - (3 * 24 * 3600);
    if (isNaN(endTime) || endTime <= 0) endTime = now;
    if (isNaN(pageSize) || pageSize <= 0) pageSize = 10;
    
    const reqToken = getReqToken(req);
    
    try {
        const apiRes = await callShopeeAPI(startTime, endTime, pageSize, nextPos, reqToken);
        if (!apiRes) return res.status(500).json({ success: false, error: 'Empty response from ShopeePay API' });
        if (apiRes.code !== 0) {
            return res.status(400).json({ success: false, error: apiRes.msg || 'API error code ' + apiRes.code });
        }
        
        const rawTxns = apiRes.data && apiRes.data.list || [];
        const transactions = [];
        
        for (const raw of rawTxns) {
            const formatted = formatTransaction(raw);
            try {
                const detail = await callShopeeDetailAPI(raw.displayTransactionId || raw.transactionId, reqToken);
                if (detail && detail.code === 0 && detail.data) {
                    formatted.issuer = detail.data.issuer;
                }
            } catch (err) {
                logEvent('WARN', 'Error checking detail for ' + raw.transactionId + ': ' + err.message);
            }
            transactions.push(formatted);
        }
        
        res.json({ success: true, total_amount: apiRes.data && apiRes.data.total_amount || '0', data: { transactions } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/check-payment', apiKeyMiddleware, async (req, res) => {
    const { amount, startTime } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Provide valid amount (positive integer)' });
    
    const reqToken = getReqToken(req);
    const endTime = Math.floor(Date.now() / 1000);
    let start = parseInt(startTime, 10);
    if (isNaN(start) || start <= 0) {
        start = endTime - (30 * 60);
    }
    
    logEvent('INFO', 'Memulai pengecekan pembayaran stateless. Nominal: Rp ' + amount + ' sejak ' + new Date(start * 1000).toISOString());
    
    try {
        const apiRes = await callShopeeAPI(start, endTime, 50, '', reqToken);
        if (!apiRes) return res.status(500).json({ success: false, error: 'Empty response from ShopeePay API' });
        if (apiRes.code !== 0) return res.status(400).json({ success: false, error: apiRes.msg || 'API error code ' + apiRes.code });
        
        const rawTxns = apiRes.data && apiRes.data.list || [];
        const targetAmount = Number(amount);
        
        const match = rawTxns.find(txn => {
            const amtStr = String(txn.amount || '0').replace(/\./g, '').replace(/,/g, '');
            const amt = parseInt(amtStr, 10) || 0;
            const txnId = txn.transactionId || txn.displayTransactionId;
            
            return txn.status === 3 && amt === targetAmount && txn.create_time >= start && !usedTransactionIds.has(txnId);
        });
        
        if (!match) {
            logEvent('INFO', 'Pembayaran sebesar Rp ' + amount + ' BELUM ditemukan.');
            return res.json({ success: true, paid: false });
        }
        
        const matchedId = match.transactionId || match.displayTransactionId;
        usedTransactionIds.set(matchedId, match.create_time);
        
        const cutoff = Math.floor(Date.now() / 1000) - (24 * 3600);
        for (const [id, time] of usedTransactionIds.entries()) {
            if (time < cutoff) usedTransactionIds.delete(id);
        }
        
        logEvent('INFO', 'Pembayaran DITEMUKAN. ID: ' + matchedId);
        
        const formatted = formatTransaction(match);
        try {
            const detail = await callShopeeDetailAPI(matchedId, reqToken);
            if (detail && detail.code === 0 && detail.data) {
                formatted.issuer = detail.data.issuer;
            }
        } catch (err) {
            logEvent('WARN', 'Error checking detail for ' + matchedId + ': ' + err.message);
        }
        
        res.json({
            success: true,
            paid: true,
            transaction: {
                transactionId: matchedId,
                amount: formatted.amount,
                status: formatted.status,
                time: formatted.time,
                issuer: formatted.issuer || 'ShopeePay/QRIS'
            }
        });
    } catch (error) {
        logEvent('ERROR', 'Pengecekan gagal karena exception: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/logs', apiKeyMiddleware, (req, res) => {
    res.json({ success: true, data: { logs } });
});

app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
    console.log('Endpoints:');
    console.log('  POST /update-token       - Update ShopeeToken');
    console.log('  GET  /token-status       - Check token valid/invalid');
    console.log('  POST /generate-qris      - Create dynamic QR');
    console.log('  GET  /transactions       - Fetch tx list');
    console.log('  POST /check-payment      - Stateless check by amount');
    console.log('  GET  /logs               - View system logs');
    
    if (shopeeToken && apiKey) {
        startTokenChecker();
    } else {
        console.warn('WARN: SHOPEE_TOKEN atau API_KEY belum diset di .env');
    }
});

app.get('/', (req, res) => {
    res.send('Shoppe API Running');
});
