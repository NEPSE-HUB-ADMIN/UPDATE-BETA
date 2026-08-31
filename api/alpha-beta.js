// api/alpha-beta.js — Standalone Alpha/Beta Calculator
import { createClient } from '@supabase/supabase-js';

// ─── Supabase Client ──────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ─── CORS Headers ─────────────────────────────────────────────────────────────
function setCorsHeaders(res, origin) {
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    res.setHeader('Vary', 'Origin');
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    setCorsHeaders(res, req.headers.origin);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed. Use GET.' });
    }

    const { symbol, force, days } = req.query;

    if (!symbol) {
        return res.status(400).json({ 
            error: 'Symbol parameter is required',
            example: 'GET /api/alpha-beta?symbol=NABIL'
        });
    }

    const symbolUpper = symbol.toUpperCase();
    const lookbackDays = parseInt(days) || 252; // Default: 1 year

    try {
        // ─── Step 1: Check cache (if not forcing refresh) ────────────────────
        if (!force) {
            const { data: cached, error: cacheError } = await supabase
                .from('alpha_beta')
                .select('*')
                .eq('symbol', symbolUpper)
                .single();

            if (!cacheError && cached) {
                const updatedAt = new Date(cached.updated_at);
                const hoursSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
                
                // Return cached if less than 24 hours old
                if (hoursSinceUpdate < 24) {
                    return res.status(200).json({
                        success: true,
                        from_cache: true,
                        data: {
                            symbol: cached.symbol,
                            alpha: cached.alpha,
                            beta: cached.beta,
                            r_squared: cached.r_squared,
                            volatility: cached.volatility,
                            correlation: cached.correlation,
                            period_days: cached.period_days,
                            start_date: cached.start_date,
                            end_date: cached.end_date,
                            updated_at: cached.updated_at
                        },
                        cache_hours: Math.round(hoursSinceUpdate)
                    });
                }
            }
        }

        // ─── Step 2: Fetch stock prices ──────────────────────────────────────
        const { data: stockData, error: stockError } = await supabase
            .from('stock_prices')
            .select('date, close')
            .eq('symbol', symbolUpper)
            .order('date', { ascending: true })
            .limit(lookbackDays + 50); // Extra buffer for alignment

        if (stockError) {
            return res.status(500).json({ 
                error: 'Failed to fetch stock data', 
                details: stockError.message 
            });
        }

        if (!stockData || stockData.length < 20) {
            return res.status(404).json({ 
                error: 'Insufficient stock data', 
                details: `Found ${stockData?.length || 0} records, need at least 20`
            });
        }

        // ─── Step 3: Fetch NEPSE Index data ─────────────────────────────────
        const startDate = stockData[0].date;
        const endDate = stockData[stockData.length - 1].date;

        const { data: indexData, error: indexError } = await supabase
            .from('nepse_index_historical')
            .select('date, close')
            .order('date', { ascending: true })
            .gte('date', startDate)
            .lte('date', endDate);

        if (indexError) {
            return res.status(500).json({ 
                error: 'Failed to fetch NEPSE index data', 
                details: indexError.message 
            });
        }

        if (!indexData || indexData.length < 20) {
            return res.status(404).json({ 
                error: 'Insufficient NEPSE index data', 
                details: `Found ${indexData?.length || 0} records, need at least 20`
            });
        }

        // ─── Step 4: Align dates ──────────────────────────────────────────────
        const stockMap = new Map(stockData.map(s => [s.date, s.close]));
        const indexMap = new Map(indexData.map(i => [i.date, i.close]));

        // Find common dates
        const commonDates = [];
        for (const [date] of stockMap) {
            if (indexMap.has(date)) {
                commonDates.push(date);
            }
        }
        commonDates.sort();

        if (commonDates.length < 20) {
            return res.status(404).json({ 
                error: 'Insufficient overlapping data', 
                details: `Found ${commonDates.length} overlapping days, need at least 20`
            });
        }

        // ─── Step 5: Calculate returns ────────────────────────────────────────
        const stockReturns = [];
        const indexReturns = [];

        for (let i = 1; i < commonDates.length; i++) {
            const stockPrev = stockMap.get(commonDates[i-1]);
            const stockCurr = stockMap.get(commonDates[i]);
            const indexPrev = indexMap.get(commonDates[i-1]);
            const indexCurr = indexMap.get(commonDates[i]);

            const stockRet = (stockCurr - stockPrev) / stockPrev;
            const indexRet = (indexCurr - indexPrev) / indexPrev;

            stockReturns.push(stockRet);
            indexReturns.push(indexRet);
        }

        // ─── Step 6: Calculate Beta ───────────────────────────────────────────
        // Beta = Covariance(stock, index) / Variance(index)
        const stockMean = stockReturns.reduce((a, b) => a + b, 0) / stockReturns.length;
        const indexMean = indexReturns.reduce((a, b) => a + b, 0) / indexReturns.length;

        let covariance = 0;
        let indexVariance = 0;
        let stockVariance = 0;

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

        // ─── Step 7: Calculate Alpha ──────────────────────────────────────────
        // Alpha = stockReturn - (beta * indexReturn) - riskFreeRate
        const riskFreeRate = 0.04 / 252; // Daily risk-free rate (4% annual)
        const alpha = stockMean - (beta * indexMean) - riskFreeRate;

        // ─── Step 8: Calculate Additional Metrics ─────────────────────────────
        // Correlation
        const correlation = (covariance / (Math.sqrt(stockVariance) * Math.sqrt(indexVariance))) || 0;

        // R-Squared
        const rSquared = correlation * correlation;

        // Annualized Volatility
        const dailyVolatility = Math.sqrt(stockVariance);
        const annualizedVolatility = dailyVolatility * Math.sqrt(252);

        // ─── Step 9: Store in alpha_beta table ──────────────────────────────
        const record = {
            symbol: symbolUpper,
            alpha: parseFloat(alpha.toFixed(6)),
            beta: parseFloat(beta.toFixed(4)),
            r_squared: parseFloat(rSquared.toFixed(4)),
            volatility: parseFloat(annualizedVolatility.toFixed(4)),
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
            console.error('Upsert error:', upsertError);
            // Continue anyway, we'll return the calculated data
        }

        // ─── Step 10: Return results ──────────────────────────────────────────
        return res.status(200).json({
            success: true,
            from_cache: false,
            data: record,
            debug: {
                stock_records: stockData.length,
                index_records: indexData.length,
                overlapping_days: commonDates.length,
                returns_calculated: stockReturns.length,
                stock_mean_return: parseFloat(stockMean.toFixed(6)),
                index_mean_return: parseFloat(indexMean.toFixed(6))
            }
        });

    } catch (error) {
        console.error('Alpha/Beta calculation error:', error);
        return res.status(500).json({
            error: 'Alpha/Beta calculation failed',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}
