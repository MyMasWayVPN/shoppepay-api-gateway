'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;

// Konfigurasi Environment Variables
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

// Fungsi Logging Internal
function logEvent(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
    logs.push({ timestamp, level, message });
    if (logs.length > MAX_LOGS) logs.shift();
}

// User-Agent Rotator untuk menghindari pemblokiran Shopee
const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    // ... beberapa UA disingkat untuk keterbacaan
];
function randomUA() { return userAgents[Math.floor(Math.random() * userAgents.length)]; }

const statusMap = { 1: 'UNPAID', 2: 'SUCCESS', 3: 'EXPIRED', 4: 'FAILED', 5: 'REFUNDED' };

// Middleware Setup
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

// Fungsi Pengecekan Transaksi & Telegram
async function sendTelegramNotif(message) {
    if (!telegramBotToken || !telegramChatID) return console.log('Telegram bot belum diset');
    try {
        await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            chat_id: telegramChatID,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 10000 });
    } catch (err) {
        console.log('Error mengirim telegram:', err.message);
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
        headers: { 'Content-Type': 'application/json', 'User-Agent': randomUA() },
        timeout: 20000
    });
    return response.data;
}

// TLV Parser & QRIS Generator (Manipulasi Nominal QRIS Statis)
function parseTLV(qrisStr) { /* Ekstraksi Tag, Length, Value dari string QRIS */ }
function buildTLV(tlvArray) { /* Rekonstruksi array TLV menjadi string QRIS */ }
function crc16CCITT(data) { /* Kalkulasi Checksum CRC16 di akhir QRIS */ }

function generateDynamicQRIS(staticQR, amount) {
    if (!staticQR) throw new Error("QRIS statis tidak dikonfigurasi");
    const parsed = parseTLV(staticQR);
    const newQR = [];
    let hasAmount = false;
    
    for (const item of parsed) {
        if (item[0] === '63') continue; // Abaikan CRC lama
        if (item[0] === '54') {
            newQR.push(['54', String(amount)]);
            hasAmount = true;
            continue;
        }
        newQR.push(item);
    }
    if (!hasAmount) newQR.push(['54', String(amount)]); // Tambahkan nominal jika belum ada

    let rawString = buildTLV(newQR) + '6304';
    const crc = crc16CCITT(rawString);
    return rawString + crc;
}

// ---------------------------------------------
// ENDPOINTS
// ---------------------------------------------

app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Server is healthy', timestamp: new Date().toISOString() });
});

app.post('/update-token', apiKeyMiddleware, (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token diperlukan' });
    shopeeToken = token;
    logEvent('INFO', 'Token ShopeePay berhasil diperbarui.');
    res.json({ success: true, data: { message: 'Token updated' } });
});

app.get('/token-status', apiKeyMiddleware, (req, res) => {
    res.json({ success: tokenValid, data: { token_status: tokenValid ? 'valid' : 'invalid' } });
});

app.post('/generate-qris', apiKeyMiddleware, (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Nominal tidak valid' });
    
    try {
        const dynamicQR = generateDynamicQRIS(qrisStatic, amount);
        const qrId = crypto.randomBytes(4).toString('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // Kedaluwarsa 15 menit
        
        qrisStore.set(qrId, { data: dynamicQR, expiresAt });
        
        res.json({
            success: true,
            data: {
                qris_url: `${req.protocol}://${req.get('host')}/qr/${qrId}`,
                amount: amount,
                expires_in: 15 * 60
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/qr/:id', (req, res) => {
    const qrData = qrisStore.get(req.params.id);
    if (!qrData) return res.status(404).send('QRIS tidak ditemukan atau kedaluwarsa');
    if (Date.now() > qrData.expiresAt.getTime()) {
        qrisStore.delete(req.params.id);
        return res.status(410).send('QRIS telah kedaluwarsa');
    }
    res.redirect(302, 'shopeepay://?qris=' + encodeURIComponent(qrData.data)); // Deep link ke aplikasi
});

app.get('/transactions', apiKeyMiddleware, async (req, res) => {
    // Memanggil callShopeeAPI untuk mengambil daftar mutasi dan menerjemahkan output
});

app.get('/check-payment', apiKeyMiddleware, async (req, res) => {
    // Endpoint stateless untuk memvalidasi apakah mutasi dengan 'amount' tertentu sudah masuk ke akun ShopeePay sejak 'startTime'.
});

app.get('/logs', apiKeyMiddleware, (req, res) => {
    res.json({ success: true, data: { logs } });
});

app.get('/', (req, res) => { res.send('Shoppe API Running'); });

app.listen(PORT, () => {
    console.log(`Server berjalan pada port ${PORT}`);
    // Mulai worker pengecekan Token Shopee interval berkala
});
