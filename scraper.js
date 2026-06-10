require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// مصادر البنوك المباشرة
const bankSources = [
    {
        nameAr: 'البنك الأهلي المصري',
        url: 'https://www.nbe.com.eg/NBE/A/#/AR/ExchangeRatesAndCurrencyConverter',
        parser: parseNBE
    },
    {
        nameAr: 'بنك مصر',
        url: 'https://www.banquemisr.com/ar/RetailBanking/Pages/ExchangeRate.aspx',
        parser: parseBanqueMisr
    },
];

// Parser للبنك الأهلي
async function parseNBE() {
    try {
        const res = await axios.get(
            'https://www.nbe.com.eg/NBE/E/#/EN/ExchangeRatesAndCurrencyConverter',
            { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const $ = cheerio.load(res.data);
        let buy = 0, sell = 0;
        $('table tr').each((i, row) => {
            const cells = $(row).find('td');
            if ($(cells[0]).text().includes('USD') || $(cells[0]).text().includes('Dollar')) {
                buy = parseFloat($(cells[1]).text().trim()) || 0;
                sell = parseFloat($(cells[2]).text().trim()) || 0;
            }
        });
        return { buy, sell };
    } catch { return null; }
}

// Parser لبنك مصر
async function parseBanqueMisr() {
    try {
        const res = await axios.get(
            'https://www.banquemisr.com/ar/RetailBanking/Pages/ExchangeRate.aspx',
            { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const $ = cheerio.load(res.data);
        let buy = 0, sell = 0;
        $('tr').each((i, row) => {
            const text = $(row).text();
            if (text.includes('دولار') || text.includes('USD')) {
                const cells = $(row).find('td');
                buy = parseFloat($(cells[1]).text().trim()) || 0;
                sell = parseFloat($(cells[2]).text().trim()) || 0;
            }
        });
        return { buy, sell };
    } catch { return null; }
}

// الدالة الرئيسية — تجيب من egrates كـ fallback موثوق
async function scrapeEgrates() {
    try {
        const res = await axios.get('https://egrates.com/en', {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html',
            }
        });

        const $ = cheerio.load(res.data);
        const rates = [];

        $('table tr').each((i, row) => {
            const bankName = $(row).find('img').attr('alt') || $(row).find('img').attr('title') || '';
            const cells = $(row).find('td');
            if (cells.length >= 3 && bankName) {
                const buy = parseFloat($(cells[1]).text().trim());
                const sell = parseFloat($(cells[2]).text().trim());
                if (buy > 40 && sell > 40 && buy < 200 && sell < 200) {
                    rates.push({ bankName: bankName.trim(), buy, sell });
                }
            }
        });

        return rates;
    } catch (e) {
        console.error('egrates error:', e.message);
        return [];
    }
}

// ربط أسماء egrates بأسماء الـ database
const nameMapping = {
    'National Bank Of Egypt': 'البنك الأهلي المصري',
    'Banque Misr': 'بنك مصر',
    'CIB Bank': 'البنك التجاري الدولي CIB',
    'Bank of Alexandria': 'بنك الإسكندرية',
    'Banque du Caire': 'بنك القاهرة',
    'Arab African International Bank': 'البنك العربي الأفريقي الدولي',
    'QNB Bank': 'بنك قطر الوطني الأهلي',
    'First Abu Dhabi Bank': 'بنك أبو ظبي الأول',
    'HSBC Bank': 'بنك HSBC مصر',
    'National Bank of Kuwait(NBK)': 'البنك الأهلي الكويتي - مصر',
    'Blom Bank': 'بنك بلوم مصر',
    'Arab International Bank': 'بنك الاستثمار العربي',
    'Housing & Development Bank': 'بنك التعمير والإسكان',
    'Al Baraka Bank': 'بنك البركة مصر',
    'The United Bank of Egypt': 'المصرف المتحد',
    'Egyptian Gulf Bank': 'البنك المصري الخليجي',
    'Central Bank of Egypt': 'البنك المركزي المصري',
    'Al Ahli Bank of Kuwait': 'البنك الأهلي الكويتي - مصر',
    'Abu Dhabi Islamic Bank': 'بنك أبو ظبي الإسلامي مصر',
    'Arab Bank': 'البنك العربي',
    'Suez Canal Bank': 'بنك قناة السويس',
    'Credit Agricole': 'بنك كريدي أجريكول مصر',
    'Societe Generale': 'بنك سوسيتيه جنرال مصر',
    'Faisal Islamic Bank': 'بنك فيصل الإسلامي المصري',
    'MIDBANK': 'بنك مصر إيران للتنمية',
};

async function updateRates() {
    console.log('🚀 Starting scrape at', new Date().toISOString());

    const rates = await scrapeEgrates();
    console.log(`📊 Scraped ${rates.length} banks`);

    if (rates.length === 0) {
        console.log('❌ No rates found');
        return;
    }

    // جيب كل البنوك من Supabase
    const { data: banks } = await supabase
        .from('banks')
        .select('id, name_ar, buy_rate, sell_rate');

    let updated = 0;

    for (const rate of rates) {
        const arabicName = nameMapping[rate.bankName];
        if (!arabicName) continue;

        const bank = banks?.find(b => b.name_ar === arabicName);
        if (!bank) continue;

        if (rate.buy === bank.buy_rate && rate.sell === bank.sell_rate) continue;

        // حدّث السعر
        const { error } = await supabase
            .from('banks')
            .update({
                previous_buy_rate: bank.buy_rate,
                previous_sell_rate: bank.sell_rate,
                buy_rate: rate.buy,
                sell_rate: rate.sell,
                last_updated: new Date().toISOString()
            })
            .eq('id', bank.id);

        if (!error) {
            // سجّل في التاريخ
            await supabase.from('rate_history').insert({
                bank_id: bank.id,
                buy_rate: rate.buy,
                sell_rate: rate.sell,
                recorded_at: new Date().toISOString()
            });
            updated++;
            console.log(`✅ Updated: ${arabicName} - Buy: ${rate.buy} Sell: ${rate.sell}`);
        }
    }

    console.log(`✨ Done! Updated ${updated} banks`);
}

const http = require('http');

// Keep-alive server عشان Render ميناموش
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'alive',
        lastRun: new Date().toISOString()
    }));
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🟢 Keep-alive server running');
});

// شغّل فوراً
updateRates().catch(console.error);

// بعدين كل دقيقة
setInterval(() => {
    updateRates().catch(console.error);
}, 60 * 1000);

console.log('🔄 Worker started - updating every minute');