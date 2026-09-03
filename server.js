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

// In-memory stores. They are intentionally non-persistent.
const qrisStore = new Map();
const usedTransactionIds = new Map();

let tokenValid = true;
let tokenNotifSent = false;

const logs = [];
const MAX_LOGS = 100;

function logEvent(level, message) {
    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] [${level}] ${message}`);

    logs.push({
        timestamp,
        level,
        message,
    });

    if (logs.length > MAX_LOGS) {
        logs.shift();
    }
}

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

function randomUA() {
    return userAgents[
        Math.floor(Math.random() * userAgents.length)
    ];
}

const statusMap = {
    1: 'pending',
    2: 'failed',
    3: 'success',
    4: 'refunded',
    5: 'expired',
};

app.use(
    cors({
        origin: '*',
        credentials: true,
    })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

function apiKeyMiddleware(req, res, next) {
    const requestKey =
        req.headers['x-api-key'] ||
        req.query.api_key;

    if (!requestKey || requestKey !== apiKey) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or missing API key',
        });
    }

    next();
}

function formatTransaction(transaction) {
    const createdAt =
        new Date(transaction.createTime * 1000);

    // Preserve the original conversion: +7 hours.
    const displayTime =
        new Date(
            createdAt.getTime() +
            7 * 60 * 60 * 1000
        );

    const pad2 = (value) =>
        String(value).padStart(2, '0');

    const time =
        `${displayTime.getUTCFullYear()}-${pad2(
            displayTime.getUTCMonth() + 1
        )}-${pad2(
            displayTime.getUTCDate()
        )} ` +
        `${pad2(
            displayTime.getUTCHours()
        )}:${pad2(
            displayTime.getUTCMinutes()
        )}:${pad2(
            displayTime.getUTCSeconds()
        )}`;

    const normalizedAmount =
        String(transaction.amount || '0')
            .replace(/\./g, '')
            .replace(/,/g, '');

    const amount =
        parseInt(normalizedAmount, 10) || 0;

    const status =
        statusMap[transaction.status] ||
        `unknown_${transaction.status}`;

    return {
        amount,
        status,
        time,
    };
}

function getReqToken(req) {
    return (
        req.headers['x-shopee-token'] ||
        shopeeToken
    );
}

async function callShopeeAPI(
    startTime,
    endTime,
    pageSize,
    nextPosition,
    token = shopeeToken
) {
    const payload = {
        data: {
            metadata: {
                token,
                language: 'id',
                timezone: 'Asia/Jakarta',
            },

            pageSize,

            filter: {
                startTime,
                endTime,
                serviceList: [1, 3],
            },

            sorter: {
                field: 'createTime',
                order: 'descend',
            },

            next_position:
                nextPosition || '',
        },
    };

    const headers = {
        'Content-Type': 'application/json',

        Origin:
            'https://partner.shopee.co.id',

        Referer:
            'https://partner.shopee.co.id/',

        'User-Agent':
            randomUA(),

        'X-Timestamp-Ms':
            String(Date.now()),
    };

    const response = await axios.post(
        'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list',
        payload,
        {
            headers,
            timeout: 20_000,
        }
    );

    return response.data;
}

async function callShopeeDetailAPI(
    orderSN,
    token = shopeeToken
) {
    const payload = {
        data: {
            metadata: {
                token,
                language: 'id',
                timezone: 'Asia/Jakarta',
            },

            order_sn: orderSN,
        },
    };

    const headers = {
        'Content-Type': 'application/json',

        Origin:
            'https://partner.shopee.co.id',

        Referer:
            'https://partner.shopee.co.id/',

        'User-Agent':
            randomUA(),

        'X-Timestamp-Ms':
            String(Date.now()),
    };

    const response = await axios.post(
        'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-detail',
        payload,
        {
            headers,
            timeout: 20_000,
        }
    );

    return response.data;
}

async function sendTelegramNotif(message) {
    if (
        !telegramBotToken ||
        !telegramChatID
    ) {
        console.log(
            '[TELEGRAM] Bot token atau chat ID belum diset'
        );

        return;
    }

    const url =
        `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

    try {
        await axios.post(
            url,
            {
                chat_id: telegramChatID,
                text: message,
                parse_mode: 'HTML',
            },
            {
                timeout: 10_000,
            }
        );

        console.log(
            '[TELEGRAM] Notif sent'
        );
    } catch (error) {
        console.error(
            '[TELEGRAM] Send failed:',
            error.message
        );
    }
}

function parseTLV(qris) {
    const result = [];
    let position = 0;

    while (position < qris.length) {
        if (position + 4 > qris.length) {
            break;
        }

        const tag =
            qris.slice(
                position,
                position + 2
            );

        const length =
            parseInt(
                qris.slice(
                    position + 2,
                    position + 4
                ),
                10
            );

        if (Number.isNaN(length)) {
            break;
        }

        position += 4;

        if (
            position + length >
            qris.length
        ) {
            break;
        }

        const value =
            qris.slice(
                position,
                position + length
            );

        position += length;

        result.push([
            tag,
            value,
        ]);
    }

    return result;
}

function buildTLV(items) {
    let result = '';

    for (
        const [tag, value]
        of items
    ) {
        result +=
            tag +
            String(value.length)
                .padStart(2, '0') +
            value;
    }

    return result;
}

function crc16CCITT(input) {
    let crc = 0xffff;

    for (
        let i = 0;
        i < input.length;
        i++
    ) {
        crc ^=
            input.charCodeAt(i)
            << 8;

        for (
            let bit = 0;
            bit < 8;
            bit++
        ) {
            if (crc & 0x8000) {
                crc =
                    ((crc << 1) ^
                        0x1021) &
                    0xffff;
            } else {
                crc =
                    (crc << 1) &
                    0xffff;
            }
        }
    }

    return crc
        .toString(16)
        .toUpperCase()
        .padStart(4, '0');
}

function generateDynamicQRIS(
    staticQRIS,
    amount
) {
    if (!staticQRIS) {
        throw new Error(
            'QRIS_STATIC belum diset di .env'
        );
    }

    const tags =
        parseTLV(staticQRIS);

    if (tags.length === 0) {
        throw new Error(
            'invalid QRIS format'
        );
    }

    const rebuilt = [];
    let hasAmountTag = false;

    for (
        const [tag, value]
        of tags
    ) {
        // Remove old CRC tag.
        if (tag === '63') {
            continue;
        }

        // Replace existing amount tag.
        if (tag === '54') {
            rebuilt.push([
                '54',
                String(amount),
            ]);

            hasAmountTag = true;
            continue;
        }

        rebuilt.push([
            tag,
            value,
        ]);
    }

    // Insert Tag 54 after Tag 53
    // if Tag 54 doesn't already exist.
    if (!hasAmountTag) {
        const withAmount = [];

        for (
            const item
            of rebuilt
        ) {
            withAmount.push(item);

            if (item[0] === '53') {
                withAmount.push([
                    '54',
                    String(amount),
                ]);
            }
        }

        rebuilt.length = 0;
        rebuilt.push(...withAmount);
    }

    let qris =
        buildTLV(rebuilt);

    qris += '6304';

    return (
        qris +
        crc16CCITT(qris)
    );
}

async function checkToken() {
    const now =
        Math.floor(
            Date.now() / 1000
        );

    const startTime =
        now - 3600;

    try {
        const response =
            await callShopeeAPI(
                startTime,
                now,
                1,
                ''
            );

        if (
            !response ||
            response.code !== 0
        ) {
            const message =
                response
                    ? response.msg
                    : 'Invalid response format';

            logEvent(
                'ERROR',
                `Token invalid: ${message}`
            );

            tokenValid = false;

            if (!tokenNotifSent) {
                await sendTelegramNotif(
                    `⚠️ <b>Shopee API</b>\n\nToken invalid: ${message}\n\nUpdate token via POST /update-token`
                );

                tokenNotifSent = true;
            }

            return;
        }

        logEvent(
            'INFO',
            'Token valid'
        );

        tokenValid = true;
        tokenNotifSent = false;

    } catch (error) {
        logEvent(
            'ERROR',
            `Token check failed: ${error.message}`
        );

        tokenValid = false;

        if (!tokenNotifSent) {
            await sendTelegramNotif(
                `⚠️ <b>Shopee API</b>\n\nToken error: ${error.message}\n\nUpdate token via POST /update-token`
            );

            tokenNotifSent = true;
        }
    }
}

function startTokenChecker() {
    checkToken();

    setInterval(
        checkToken,
        5 * 60 * 1000
    );
}

app.get(
    '/api/health',
    (req, res) => {
        res.json({
            success: true,
            message:
                'ShopeePay API Service is running',

            timestamp:
                new Date().toISOString(),
        });
    }
);

app.post(
    '/update-token',
    apiKeyMiddleware,
    (req, res) => {
        const { token } =
            req.body;

        if (!token) {
            return res
                .status(400)
                .json({
                    success: false,
                    error:
                        'Provide token in body',
                });
        }

        shopeeToken = token;

        logEvent(
            'INFO',
            'Token updated via API'
        );

        return res.json({
            success: true,

            data: {
                message:
                    'Token updated',
            },
        });
    }
);

app.get(
    '/token-status',
    apiKeyMiddleware,
    (req, res) => {
        res.json({
            success:
                tokenValid,

            data: {
                token_status:
                    tokenValid
                        ? 'valid'
                        : 'invalid',

                message:
                    tokenValid
                        ? 'Token is working'
                        : 'Token expired/invalid. Please update via POST /update-token',
            },
        });
    }
);

app.post(
    '/create-qris',
    apiKeyMiddleware,
    (req, res) => {
        const { amount } =
            req.body;

        if (
            !amount ||
            amount <= 0
        ) {
            return res
                .status(400)
                .json({
                    success: false,
                    error:
                        'Provide valid amount (positive integer)',
                });
        }

        try {
            const qrisData =
                generateDynamicQRIS(
                    qrisStatic,
                    amount
                );

            const id =
                crypto
                    .randomBytes(4)
                    .toString('hex');

            // Stored for 15 minutes.
            const expiresAt =
                new Date(
                    Date.now() +
                    15 * 60 * 1000
                );

            qrisStore.set(
                id,
                {
                    data: qrisData,
                    expiresAt,
                }
            );

            const host =
                req.get('host');

            const protocol =
                req.protocol;

            const qrisURL =
                `${protocol}://${host}/qr/${id}`;

            // Original second +7 minute
            // calculation preserved.
            const displayExpiresAt =
                new Date(
                    expiresAt.getTime() +
                    7 * 60 * 1000
                );

            const pad2 =
                (value) =>
                    String(value)
                        .padStart(2, '0');

            const expires_at =
                `${displayExpiresAt.getUTCFullYear()}-${pad2(displayExpiresAt.getUTCMonth() + 1)}-${pad2(displayExpiresAt.getUTCDate())} ` +
                `${pad2(displayExpiresAt.getUTCHours())}:${pad2(displayExpiresAt.getUTCMinutes())}:${pad2(displayExpiresAt.getUTCSeconds())}`;

            return res.json({
                success: true,

                data: {
                    qris_url:
                        qrisURL,

                    amount,

                    expires_at,

                    expires_in:
                        '15 menit',
                },
            });

        } catch (error) {
            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message,
                });
        }
    }
);

app.get(
    '/qr/:id',
    (req, res) => {
        const id =
            req.params.id;

        const qris =
            qrisStore.get(id);

        if (!qris) {
            return res
                .status(404)
                .send('QR not found');
        }

        if (
            Date.now() >
            qris.expiresAt.getTime()
        ) {
            qrisStore.delete(id);

            return res
                .status(410)
                .send('QR expired');
        }

        // QR image rendering is delegated
        // to qrserver.com.
        const imageURL =
            'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' +
            encodeURIComponent(
                qris.data
            );

        return res.redirect(
            302,
            imageURL
        );
    }
);

app.get(
    '/transactions',
    apiKeyMiddleware,
    async (req, res) => {
        const now =
            Math.floor(
                Date.now() / 1000
            );

        let startTime =
            parseInt(
                req.query.startTime,
                10
            );

        let endTime =
            parseInt(
                req.query.endTime,
                10
            );

        let pageSize =
            parseInt(
                req.query.pageSize,
                10
            );

        const nextPosition =
            req.query.next_position ||
            '';

        if (
            Number.isNaN(startTime) ||
            startTime === 0
        ) {
            startTime =
                now -
                3 * 24 * 60 * 60;
        }

        if (
            Number.isNaN(endTime) ||
            endTime === 0
        ) {
            endTime = now;
        }

        if (
            Number.isNaN(pageSize) ||
            pageSize === 0
        ) {
            pageSize = 10;
        }

        const token =
            getReqToken(req);

        try {
            const response =
                await callShopeeAPI(
                    startTime,
                    endTime,
                    pageSize,
                    nextPosition,
                    token
                );

            if (!response) {
                return res
                    .status(500)
                    .json({
                        success: false,
                        error:
                            'Empty response from ShopeePay API',
                    });
            }

            if (
                response.code !== 0
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            response.msg ||
                            `API error code ${response.code}`,
                    });
            }

            const list =
                (
                    response.data &&
                    response.data.list
                ) || [];

            const transactions = [];

            for (
                const transaction
                of list
            ) {
                const formatted =
                    formatTransaction(
                        transaction
                    );

                try {
                    const detail =
                        await callShopeeDetailAPI(
                            transaction.displayTransactionId ||
                                transaction.transactionId,
                            token
                        );

                    if (
                        detail &&
                        detail.code === 0 &&
                        detail.data
                    ) {
                        formatted.issuer =
                            detail.data.issuer;
                    }

                } catch (error) {
                    logEvent(
                        'ERROR',
                        `Error checking detail for ${transaction.transactionId}: ${error.message}`
                    );
                }

                transactions.push(
                    formatted
                );
            }

            return res.json({
                success: true,

                total_amount:
                    (
                        response.data &&
                        response.data.totalNetSales
                    ) || '0',

                data: {
                    transactions,
                },
            });

        } catch (error) {
            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message,
                });
        }
    }
);

app.get(
    '/transactions/all',
    apiKeyMiddleware,
    async (req, res) => {
        const now =
            new Date();

        const currentYear =
            now.getFullYear();

        const currentMonth =
            now.getMonth();

        // Start of current month in
        // Asia/Jakarta represented
        // as Unix timestamp.
        const monthStart =
            new Date(
                Date.UTC(
                    currentYear,
                    currentMonth,
                    1,
                    0,
                    0,
                    0
                ) -
                    7 * 60 * 60 * 1000
            );

        const startTime =
            Math.floor(
                monthStart.getTime() /
                1000
            );

        const endTime =
            Math.floor(
                now.getTime() /
                1000
            );

        const pageSize = 100;

        const token =
            getReqToken(req);

        const transactions = [];

        let nextPosition = '';

        try {
            while (true) {
                const response =
                    await callShopeeAPI(
                        startTime,
                        endTime,
                        pageSize,
                        nextPosition,
                        token
                    );

                if (!response) {
                    return res
                        .status(500)
                        .json({
                            success: false,
                            error:
                                'Empty response from ShopeePay API',
                        });
                }

                if (
                    response.code !== 0
                ) {
                    return res
                        .status(400)
                        .json({
                            success: false,
                            error:
                                response.msg ||
                                `API error code ${response.code}`,
                        });
                }

                const list =
                    (
                        response.data &&
                        response.data.list
                    ) || [];

                for (
                    const transaction
                    of list
                ) {
                    const formatted =
                        formatTransaction(
                            transaction
                        );

                    try {
                        const detail =
                            await callShopeeDetailAPI(
                                transaction.displayTransactionId ||
                                    transaction.transactionId,
                                token
                            );

                        if (
                            detail &&
                            detail.code === 0 &&
                            detail.data
                        ) {
                            formatted.issuer =
                                detail.data.issuer;
                        }

                    } catch (error) {
                        logEvent(
                            'ERROR',
                            `Error checking detail for ${transaction.transactionId}: ${error.message}`
                        );
                    }

                    transactions.push(
                        formatted
                    );
                }

                if (
                    !response.data ||
                    !response.data.next_position ||
                    list.length < pageSize
                ) {
                    break;
                }

                nextPosition =
                    response.data.next_position;

                await new Promise(
                    (resolve) =>
                        setTimeout(
                            resolve,
                            500
                        )
                );
            }

            const periodStart =
                new Date(
                    monthStart.getTime() +
                    7 * 60 * 60 * 1000
                );

            const periodEnd =
                new Date(
                    now.getTime() +
                    7 * 60 * 60 * 1000
                );

            const pad2 =
                (value) =>
                    String(value)
                        .padStart(2, '0');

            const period =
                `${periodStart.getUTCFullYear()}-${pad2(periodStart.getUTCMonth() + 1)}-${pad2(periodStart.getUTCDate())}` +
                ` s/d ${periodEnd.getUTCFullYear()}-${pad2(periodEnd.getUTCMonth() + 1)}-${pad2(periodEnd.getUTCDate())}`;

            return res.json({
                success: true,

                total_amount:
                    String(
                        transactions.length
                    ),

                data: {
                    period,

                    total_count:
                        transactions.length,

                    transactions,
                },
            });

        } catch (error) {
            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message,
                });
        }
    }
);

app.post(
    '/check-payment',
    apiKeyMiddleware,
    async (req, res) => {
        const {
            amount,
            startTime:
                requestedStartTime,
        } = req.body;

        if (
            !amount ||
            amount <= 0
        ) {
            return res
                .status(400)
                .json({
                    success: false,
                    error:
                        'Provide valid amount (positive integer)',
                });
        }

        const token =
            getReqToken(req);

        const now =
            Math.floor(
                Date.now() / 1000
            );

        let startTime =
            parseInt(
                requestedStartTime,
                10
            );

        if (
            Number.isNaN(startTime) ||
            startTime === 0
        ) {
            startTime =
                now - 30 * 60;
        }

        logEvent(
            'INFO',
            `Memulai pengecekan pembayaran stateless. Nominal: Rp ${amount}, Waktu Mulai: ${new Date(startTime * 1000).toISOString()}`
        );

        try {
            const response =
                await callShopeeAPI(
                    startTime,
                    now,
                    50,
                    '',
                    token
                );

            if (!response) {
                logEvent(
                    'ERROR',
                    'Respons dari ShopeePay API kosong.'
                );

                return res
                    .status(500)
                    .json({
                        success: false,
                        error:
                            'Empty response from ShopeePay API',
                    });
            }

            if (
                response.code !== 0
            ) {
                logEvent(
                    'ERROR',
                    `API ShopeePay mengembalikan kode ${response.code}: ${response.msg}`
                );

                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            response.msg ||
                            `API error code ${response.code}`,
                    });
            }

            const list =
                (
                    response.data &&
                    response.data.list
                ) || [];

            const expectedAmount =
                Number(amount);

            const matched =
                list.find(
                    (transaction) => {
                        const normalizedAmount =
                            String(
                                transaction.amount ||
                                    '0'
                            )
                                .replace(
                                    /\./g,
                                    ''
                                )
                                .replace(
                                    /,/g,
                                    ''
                                );

                        const transactionAmount =
                            parseInt(
                                normalizedAmount,
                                10
                            ) || 0;

                        const transactionId =
                            transaction.transactionId ||
                            transaction.displayTransactionId;

                        return (
                            transaction.status ===
                                3 &&

                            transactionAmount ===
                                expectedAmount &&

                            transaction.createTime >=
                                startTime &&

                            !usedTransactionIds.has(
                                transactionId
                            )
                        );
                    }
                );

            if (!matched) {
                logEvent(
                    'INFO',
                    `Pengecekan selesai. Nominal Rp ${amount} BELUM ditemukan.`
                );

                return res.json({
                    success: true,
                    paid: false,
                });
            }

            const transactionId =
                matched.transactionId ||
                matched.displayTransactionId;

            usedTransactionIds.set(
                transactionId,
                matched.createTime
            );

            // Retain only the last 24 hours
            // of consumed transaction IDs.
            const cleanupBefore =
                Math.floor(
                    Date.now() / 1000
                ) -
                24 * 60 * 60;

            for (
                const [
                    id,
                    createdAt,
                ] of usedTransactionIds.entries()
            ) {
                if (
                    createdAt <
                    cleanupBefore
                ) {
                    usedTransactionIds.delete(
                        id
                    );
                }
            }

            logEvent(
                'INFO',
                `Pencocokan berhasil! Transaksi ditemukan: ${transactionId}. Mengambil detail...`
            );

            const formatted =
                formatTransaction(
                    matched
                );

            try {
                const detail =
                    await callShopeeDetailAPI(
                        matched.displayTransactionId ||
                            matched.transactionId,
                        token
                    );

                if (
                    detail &&
                    detail.code === 0 &&
                    detail.data
                ) {
                    formatted.issuer =
                        detail.data.issuer;
                }

            } catch (error) {
                logEvent(
                    'WARN',
                    `Gagal mengambil detail transaksi ${matched.transactionId}: ${error.message}`
                );
            }

            logEvent(
                'INFO',
                `Pembayaran terverifikasi lunas via ${formatted.issuer || 'ShopeePay/QRIS'}.`
            );

            return res.json({
                success: true,

                paid: true,

                transaction: {
                    transactionId:
                        matched.transactionId ||
                        matched.displayTransactionId,

                    amount:
                        formatted.amount,

                    status:
                        formatted.status,

                    time:
                        formatted.time,

                    issuer:
                        formatted.issuer ||
                        'QRIS / ShopeePay',
                },
            });

        } catch (error) {
            logEvent(
                'ERROR',
                `Pengecekan gagal karena exception: ${error.message}`
            );

            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message,
                });
        }
    }
);

app.get(
    '/api/logs',
    apiKeyMiddleware,
    (req, res) => {
        res.json({
            success: true,

            data: {
                logs,
            },
        });
    }
);

app.listen(
    PORT,
    () => {
        console.log(
            `ShopeePay API (express) running at http://localhost:${PORT}`
        );

        console.log(
            'Endpoints:'
        );

        console.log(
            '  POST /update-token       - Update ShopeeToken'
        );

        console.log(
            '  GET  /token-status       - Check ShopeeToken Validity status'
        );

        console.log(
            '  POST /create-qris        - Generate Dynamic QRIS from static template'
        );

        console.log(
            '  GET  /qr/:id             - Fetch Dynamic QRIS Image Redirect'
        );

        console.log(
            '  GET  /transactions       - Fetch transactions list'
        );

        console.log(
            '  GET  /transactions/all   - Fetch all transactions of the month'
        );

        if (
            shopeeToken &&
            apiKey
        ) {
            startTokenChecker();
        } else {
            console.warn(
                'WARNING: SHOPEE_TOKEN and API_KEY must be set in .env to run checks.'
            );
        }
    }
);

app.get(
    '/',
    (req, res) => {
        res.send(
            'Shoppe API Running'
        );
    }
);
