// index.js — Alpha/Beta Web Service with Pagination Support
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase Client ──────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use(express.json());

// ─── Calculate Alpha/Beta for a single symbol ──────────────────────────────
async function calculateAlphaBeta(symbol) {
    console.log(`[${symbol}] Starting calculation...`);

    try {
        // Fetch stock prices (last 1 year)
        const { data: stockData, error: stockError } = await supabase
            .from('stock_prices')
            .select('date, close')
            .eq('symbol', symbol)
            .order('date', { ascending: true })
            .limit(300);

        if (stockError || !stockData || stockData.length < 20) {
            console.warn(`[${symbol}] Insufficient stock data (${stockData?.length || 0} records)`);
            return null;
        }

        // Fetch NEPSE Index data
        const startDate = stockData[0].date;
        const endDate = stockData[stockData.length - 1].date;

        const { data: indexData, error: indexError } = await supabase
            .from('nepse_index_historical')
            .select('date, close')
            .order('date', { ascending: true })
            .gte('date', startDate)
            .lte('date', endDate);

        if (indexError || !indexData || indexData.length < 20) {
            console.warn(`[${symbol}] Insufficient index data (${indexData?.length || 0} records)`);
            return null;
        }

        // Align dates
        const stockMap = new Map(stockData.map(s => [s.date, s.close]));
        const indexMap = new Map(indexData.map(i => [i.date, i.close]));

        const commonDates = [];
        for (const [date] of stockMap) {
            if (indexMap.has(date)) commonDates.push(date);
        }
        commonDates.sort();

        if (commonDates.length < 20) {
            console.warn(`[${symbol}] Only ${commonDates.length} overlapping days`);
            return null;
        }

        // Calculate returns
        const stockReturns = [];
        const indexReturns = [];

        for (let i = 1; i < commonDates.length; i++) {
            const stockPrev = stockMap.get(commonDates[i - 1]);
            const stockCurr = stockMap.get(commonDates[i]);
            const indexPrev = indexMap.get(commonDates[i - 1]);
            const indexCurr = indexMap.get(commonDates[i]);

            stockReturns.push((stockCurr - stockPrev) / stockPrev);
            indexReturns.push((indexCurr - indexPrev) / indexPrev);
        }

        // Calculate Beta
        const stockMean = stockReturns.reduce((a, b) => a + b, 0) / stockReturns.length;
        const indexMean = indexReturns.reduce((a, b) => a + b, 0) / indexReturns.length;

        let covariance = 0,
            indexVariance = 0,
            stockVariance = 0;
        for (let i = 0; i < stockReturns.length; i++) {
            const stockDiff = stockReturns[i] - stockMean;
            const indexDiff = indexReturns[i] - indexMean;
            covariance += stockDiff * indexDiff;
            indexVariance += indexDiff * indexDiff;
            stockVariance += stockDiff * stockDiff;
        }

        covariance /= stockReturns.length;
        indexVariance /= stockReturns.length;
        stockVariance /= stockReturns.length;

        const beta = indexVariance > 0 ? covariance / indexVariance : 1;
        const alpha = stockMean - (beta * indexMean) - (0.04 / 252);
        const correlation = (covariance / (Math.sqrt(stockVariance) * Math.sqrt(indexVariance))) || 0;
        const rSquared = correlation * correlation;
        const volatility = Math.sqrt(stockVariance) * Math.sqrt(252);

        // Save to database
        const record = {
            symbol: symbol,
            alpha: parseFloat(alpha.toFixed(6)),
            beta: parseFloat(beta.toFixed(4)),
            r_squared: parseFloat(rSquared.toFixed(4)),
            volatility: parseFloat(volatility.toFixed(4)),
            correlation: parseFloat(correlation.toFixed(4)),
            period_days: commonDates.length,
            start_date: commonDates[0],
            end_date: commonDates[commonDates.length - 1],
            updated_at: new Date().toISOString()
        };

        const { error: upsertError } = await supabase
            .from('alpha_beta')
            .upsert(record, { onConflict: 'symbol' });

        if (upsertError) {
            console.error(`[${symbol}] Save error:`, upsertError.message);
            return null;
        }

        console.log(`[${symbol}] ✅ Beta: ${beta.toFixed(4)}, Alpha: ${alpha.toFixed(6)}`);
        return record;

    } catch (err) {
        console.error(`[${symbol}] Error:`, err.message);
        return null;
    }
}

// ─── Update Symbols with Pagination ─────────────────────────────────────────
async function updateSymbolsBatch(offset = 0, limit = 10) {
    console.log(`\n🔄 Processing batch: offset=${offset}, limit=${limit}`);

    // Get symbols with pagination
    const { data: symbols, error: symbolsError, count } = await supabase
        .from('stock_prices')
        .select('symbol', { count: 'exact', head: false })
        .order('symbol')
        .range(offset, offset + limit - 1);

    if (symbolsError || !symbols) {
        console.error('❌ Failed to fetch symbols:', symbolsError?.message);
        return { success: false, error: symbolsError?.message };
    }

    const uniqueSymbols = [...new Set(symbols.map(s => s.symbol))];
    console.log(`📊 Processing ${uniqueSymbols.length} symbols (offset ${offset})`);

    let processed = 0;
    let failed = 0;
    const failedSymbols = [];

    for (const symbol of uniqueSymbols) {
        try {
            const result = await calculateAlphaBeta(symbol);
            if (result) {
                processed++;
            } else {
                failed++;
                failedSymbols.push(symbol);
            }
        } catch (err) {
            console.error(`[${symbol}] ❌ Error:`, err.message);
            failed++;
            failedSymbols.push(symbol);
        }
    }

    return {
        success: true,
        offset,
        limit,
        processed,
        failed,
        failedSymbols,
        totalSymbols: count || uniqueSymbols.length,
        hasMore: (offset + limit) < (count || uniqueSymbols.length),
        nextOffset: offset + limit,
        timestamp: new Date().toISOString()
    };
}

// ─── Update All Symbols (Processes All) ─────────────────────────────────────
async function updateAllSymbols() {
    console.log('\n🔄 Starting full Alpha/Beta update for ALL symbols...');
    const startTime = Date.now();

    // Get total count
    const { count, error: countError } = await supabase
        .from('stock_prices')
        .select('symbol', { count: 'exact', head: true });

    if (countError) {
        console.error('❌ Failed to get symbol count:', countError.message);
        return { success: false, error: countError.message };
    }

    console.log(`📊 Total symbols to process: ${count}`);

    let totalProcessed = 0;
    let totalFailed = 0;
    const allFailedSymbols = [];
    let offset = 0;
    const batchSize = 10;

    while (offset < count) {
        console.log(`\n📦 Processing batch ${Math.floor(offset / batchSize) + 1}/${Math.ceil(count / batchSize)}`);
        const result = await updateSymbolsBatch(offset, batchSize);
        
        totalProcessed += result.processed || 0;
        totalFailed += result.failed || 0;
        if (result.failedSymbols) {
            allFailedSymbols.push(...result.failedSymbols);
        }

        offset += batchSize;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`✅ Total Processed: ${totalProcessed} symbols`);
    console.log(`❌ Total Failed: ${totalFailed} symbols`);
    if (allFailedSymbols.length > 0) {
        console.log(`📝 Failed symbols: ${allFailedSymbols.join(', ')}`);
    }
    console.log(`⏱️  Duration: ${duration} seconds`);
    console.log('═══════════════════════════════════════════════════════════\n');

    return {
        success: true,
        totalProcessed,
        totalFailed,
        failedSymbols: allFailedSymbols,
        duration: `${duration}s`,
        timestamp: new Date().toISOString()
    };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Home
app.get('/', (req, res) => {
    res.json({
        service: 'Alpha/Beta Updater',
        version: '1.0.0',
        endpoints: [
            { method: 'GET', path: '/', description: 'Service info' },
            { method: 'GET', path: '/health', description: 'Health check' },
            { method: 'GET', path: '/run', description: 'Trigger full update (ALL symbols)' },
            { method: 'GET', path: '/run?offset=0&limit=10', description: 'Process batch (10 symbols)' },
            { method: 'GET', path: '/symbol/:symbol', description: 'Update single symbol' },
            { method: 'GET', path: '/status', description: 'Check last run status' },
            { method: 'GET', path: '/total', description: 'Get total symbol count' }
        ],
        pagination: {
            defaultLimit: 10,
            maxLimit: 50,
            usage: '/run?offset=0&limit=10'
        }
    });
});

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ─── Get Total Symbol Count ──────────────────────────────────────────────────
app.get('/total', async (req, res) => {
    const { count, error } = await supabase
        .from('stock_prices')
        .select('symbol', { count: 'exact', head: true });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({
        totalSymbols: count,
        timestamp: new Date().toISOString()
    });
});

// ─── Batch Update with Pagination ───────────────────────────────────────────
let lastRunStatus = { running: false, lastRun: null };

app.get('/run', async (req, res) => {
    const { offset, limit } = req.query;
    const parsedOffset = parseInt(offset) || 0;
    const parsedLimit = Math.min(parseInt(limit) || 10, 50); // Max 50 per batch

    if (lastRunStatus.running) {
        return res.status(409).json({
            error: 'Update already in progress',
            started: lastRunStatus.started
        });
    }

    // Check if this is a batch request or full update
    const isBatch = req.query.offset !== undefined || req.query.limit !== undefined;

    lastRunStatus = { 
        running: true, 
        started: new Date().toISOString(),
        mode: isBatch ? 'batch' : 'full'
    };

    // Send immediate response
    res.json({
        message: isBatch ? 'Batch update started' : 'Full update started',
        started: lastRunStatus.started,
        mode: isBatch ? 'batch' : 'full',
        ...(isBatch && { offset: parsedOffset, limit: parsedLimit }),
        status_url: '/status'
    });

    // Run update in background
    setTimeout(async () => {
        try {
            let result;
            if (isBatch) {
                result = await updateSymbolsBatch(parsedOffset, parsedLimit);
            } else {
                result = await updateAllSymbols();
            }
            lastRunStatus = {
                ...result,
                running: false,
                completed: new Date().toISOString(),
                mode: isBatch ? 'batch' : 'full'
            };
        } catch (err) {
            lastRunStatus = {
                error: err.message,
                running: false,
                completed: new Date().toISOString()
            };
            console.error('❌ Update failed:', err);
        }
    }, 100);
});

// ─── Update Single Symbol ────────────────────────────────────────────────────
app.get('/symbol/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();

    console.log(`[Manual] Updating single symbol: ${symbol}`);

    try {
        const result = await calculateAlphaBeta(symbol);

        if (result) {
            res.json({
                success: true,
                symbol: symbol,
                data: result,
                message: 'Updated successfully'
            });
        } else {
            res.status(404).json({
                success: false,
                symbol: symbol,
                message: 'Failed to calculate Alpha/Beta. Insufficient data.'
            });
        }
    } catch (err) {
        res.status(500).json({
            success: false,
            symbol: symbol,
            error: err.message
        });
    }
});

// ─── Status ──────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.json(lastRunStatus);
});

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`🚀 Alpha/Beta Web Service Running`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🕐 Started: ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n📊 Endpoints:');
    console.log(`   GET  /                    - Service info`);
    console.log(`   GET  /health              - Health check`);
    console.log(`   GET  /total               - Get total symbol count`);
    console.log(`   GET  /run                 - Update ALL symbols`);
    console.log(`   GET  /run?offset=0&limit=10 - Process batch (10 symbols)`);
    console.log(`   GET  /status              - Check last run status`);
    console.log(`   GET  /symbol/:symbol      - Update single symbol`);
    console.log('\n🔗 Examples:');
    console.log(`   curl https://your-app.onrender.com/run`);
    console.log(`   curl https://your-app.onrender.com/run?offset=0&limit=10`);
    console.log(`   curl https://your-app.onrender.com/symbol/NABIL`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Get total symbol count on startup
    try {
        const { count } = await supabase
            .from('stock_prices')
            .select('symbol', { count: 'exact', head: true });
        console.log(`📊 Total symbols available: ${count}`);
        console.log(`📦 Processing 10 symbols per batch\n`);
    } catch (err) {
        console.log('⚠️ Could not fetch symbol count');
    }
});
