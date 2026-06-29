'use strict';

(function () {
/**
 * Decodo residential endpoints — sticky port range + rotating port per location.
 * Source: Decodo endpoint table (gate + country subdomains).
 *
 * Tuple: [code, name, region, host|null, stickyMin, stickyMax, portRotating]
 * host=null → {code}.decodo.com
 */

const DECODO_ENDPOINT_ROWS = [
    ['random', 'Random', 'Other', 'gate.decodo.com', 10001, 49999, 10000],
    ['us', 'United States', 'Americas', null, 10001, 29999, 10000],
    ['eu', 'European Union', 'Europe', null, 10001, 29999, 10000],
    ['ae', 'United Arab Emirates', 'Middle East', null, 20001, 29999, 20000],
    ['my', 'Malaysia', 'Asia', null, 30001, 39999, 30000],
    ['ph', 'Philippines', 'Asia', null, 40001, 49999, 40000],
    ['in', 'India', 'Asia', null, 10001, 19999, 10000],
    ['tw', 'Taiwan', 'Asia', null, 20001, 29999, 20000],
    ['jp', 'Japan', 'Asia', null, 30001, 39999, 30000],
    ['be', 'Belgium', 'Europe', null, 40001, 49999, 40000],
    ['es', 'Spain', 'Europe', null, 10001, 19999, 10000],
    ['pt', 'Portugal', 'Europe', null, 20001, 29999, 20000],
    ['gr', 'Greece', 'Europe', null, 30001, 39999, 30000],
    ['pe', 'Peru', 'Americas', null, 40001, 49999, 40000],
    ['ar', 'Argentina', 'Americas', null, 10001, 19999, 10000],
    ['se', 'Sweden', 'Europe', null, 20001, 29999, 20000],
    ['az', 'Azerbaijan', 'Middle East', null, 30001, 39999, 30000],
    ['ua', 'Ukraine', 'Europe', null, 40001, 49999, 40000],
    ['hk', 'Hong Kong', 'Asia', null, 10001, 19999, 10000],
    ['de', 'Germany', 'Europe', null, 20001, 29999, 20000],
    ['ir', 'Iran', 'Middle East', null, 30001, 39999, 30000],
    ['za', 'South Africa', 'Africa', null, 40001, 49999, 40000],
    ['kr', 'South Korea', 'Asia', null, 10001, 19999, 10000],
    ['ec', 'Ecuador', 'Americas', null, 20001, 29999, 20000],
    ['cl', 'Chile', 'Americas', null, 30001, 39999, 30000],
    ['ru', 'Russia', 'Europe', null, 40001, 49999, 40000],
    ['id', 'Indonesia', 'Asia', null, 10001, 19999, 10000],
    ['eg', 'Egypt', 'Africa', null, 20001, 29999, 20000],
    ['cn', 'China', 'Asia', null, 30001, 39999, 30000],
    ['gb', 'United Kingdom', 'Europe', null, 30001, 49999, 30000],
    ['nl', 'Netherlands', 'Europe', null, 10001, 19999, 10000],
    ['it', 'Italy', 'Europe', null, 20001, 29999, 20000],
    ['au', 'Australia', 'Oceania', null, 30001, 39999, 30000],
    ['kz', 'Kazakhstan', 'Asia', null, 40001, 49999, 40000],
    ['sg', 'Singapore', 'Asia', null, 10001, 19999, 10000],
    ['mx', 'Mexico', 'Americas', null, 20001, 29999, 20000],
    ['th', 'Thailand', 'Asia', null, 30001, 39999, 30000],
    ['tr', 'Turkey', 'Middle East', null, 40001, 49999, 40000],
    ['br', 'Brazil', 'Americas', null, 10001, 19999, 10000],
    ['pl', 'Poland', 'Europe', null, 20001, 29999, 20000],
    ['co', 'Colombia', 'Americas', null, 30001, 39999, 30000],
    ['fr', 'France', 'Europe', null, 40001, 49999, 40000],
    ['pk', 'Pakistan', 'Asia', null, 10001, 19999, 10000],
    ['ca', 'Canada', 'Americas', null, 20001, 29999, 20000],
    ['il', 'Israel', 'Middle East', null, 30001, 39999, 30000],
    ['ma', 'Morocco', 'Africa', null, 40001, 40999, 40000],
    ['mz', 'Mozambique', 'Africa', null, 41001, 41999, 41000],
    ['ng', 'Nigeria', 'Africa', null, 42001, 42999, 42000],
    ['gh', 'Ghana', 'Africa', null, 43001, 43999, 43000],
    ['ci', "Côte d'Ivoire", 'Africa', null, 44001, 44999, 44000],
    ['ke', 'Kenya', 'Africa', null, 45001, 45999, 45000],
    ['lr', 'Liberia', 'Africa', null, 46001, 46999, 46000],
    ['mg', 'Madagascar', 'Africa', null, 47001, 47999, 47000],
    ['ml', 'Mali', 'Africa', null, 48001, 48999, 48000],
    ['mt', 'Malta', 'Europe', null, 49001, 49999, 49000],
    ['mc', 'Monaco', 'Europe', null, 10001, 10999, 10000],
    ['md', 'Moldova', 'Europe', null, 11001, 11999, 11000],
    ['me', 'Montenegro', 'Europe', null, 12001, 12999, 12000],
    ['no', 'Norway', 'Europe', null, 13001, 13999, 13000],
    ['py', 'Paraguay', 'Americas', null, 14001, 14999, 14000],
    ['uy', 'Uruguay', 'Americas', null, 15001, 15999, 15000],
    ['ve', 'Venezuela', 'Americas', null, 16001, 16999, 16000],
    ['dm', 'Dominica', 'Americas', null, 17001, 17999, 17000],
    ['ht', 'Haiti', 'Americas', null, 18001, 18999, 18000],
    ['hn', 'Honduras', 'Americas', null, 19001, 19999, 19000],
    ['jm', 'Jamaica', 'Americas', null, 20001, 20999, 20000],
    ['aw', 'Aruba', 'Americas', null, 21001, 21999, 21000],
    ['lv', 'Latvia', 'Europe', null, 22001, 22999, 22000],
    ['li', 'Liechtenstein', 'Europe', null, 23001, 23999, 23000],
    ['lt', 'Lithuania', 'Europe', null, 24001, 24999, 24000],
    ['lu', 'Luxembourg', 'Europe', null, 25001, 25999, 25000],
    ['jo', 'Jordan', 'Middle East', null, 26001, 26999, 26000],
    ['lb', 'Lebanon', 'Middle East', null, 27001, 27999, 27000],
    ['mv', 'Maldives', 'Asia', null, 28001, 28999, 28000],
    ['mn', 'Mongolia', 'Asia', null, 29001, 29999, 29000],
    ['om', 'Oman', 'Middle East', null, 30001, 30999, 30000],
    ['sd', 'Sudan', 'Africa', null, 31001, 31999, 31000],
    ['tg', 'Togo', 'Africa', null, 32001, 32999, 32000],
    ['tn', 'Tunisia', 'Africa', null, 33001, 33999, 33000],
    ['ug', 'Uganda', 'Africa', null, 34001, 34999, 34000],
    ['zm', 'Zambia', 'Africa', null, 35001, 35999, 35000],
    ['af', 'Afghanistan', 'Asia', null, 36001, 36999, 36000],
    ['bh', 'Bahrain', 'Middle East', null, 37001, 37999, 37000],
    ['fj', 'Fiji', 'Oceania', null, 38001, 38999, 38000],
    ['nz', 'New Zealand', 'Oceania', null, 39001, 39999, 39000],
    ['bo', 'Bolivia', 'Americas', null, 40001, 40999, 40000],
    ['bd', 'Bangladesh', 'Asia', null, 41001, 41099, 41001],
    ['am', 'Armenia', 'Middle East', null, 42001, 42999, 42000],
    ['ge', 'Georgia', 'Middle East', null, 43001, 43999, 43000],
    ['iq', 'Iraq', 'Middle East', null, 44001, 44999, 44000],
    ['bt', 'Bhutan', 'Asia', null, 45001, 45999, 45000],
    ['mm', 'Myanmar', 'Asia', null, 46001, 46999, 46000],
    ['kh', 'Cambodia', 'Asia', null, 47001, 47999, 47000],
    ['cy', 'Cyprus', 'Europe', null, 48001, 48999, 48000],
    ['sn', 'Senegal', 'Africa', null, 49001, 49999, 49000],
    ['sc', 'Seychelles', 'Africa', null, 10001, 10999, 10000],
    ['zw', 'Zimbabwe', 'Africa', null, 11001, 11999, 11000],
    ['ss', 'South Sudan', 'Africa', null, 12001, 12999, 12000],
    ['ro', 'Romania', 'Europe', null, 13001, 13999, 13000],
    ['rs', 'Serbia', 'Europe', null, 14001, 14999, 14000],
    ['sk', 'Slovakia', 'Europe', null, 15001, 15999, 15000],
    ['si', 'Slovenia', 'Europe', null, 16001, 16999, 16000],
    ['bs', 'Bahamas', 'Americas', null, 17001, 17999, 17000],
    ['bz', 'Belize', 'Americas', null, 18001, 18999, 18000],
    ['vg', 'Virgin Islands', 'Americas', null, 19001, 19999, 19000],
    ['pa', 'Panama', 'Americas', null, 20001, 20999, 20000],
    ['pr', 'Puerto Rico', 'Americas', null, 21001, 21999, 21000],
    ['tt', 'Trinidad and Tobago', 'Americas', null, 22001, 22999, 22000],
    ['is', 'Iceland', 'Europe', null, 23001, 23999, 23000],
    ['ie', 'Ireland', 'Europe', null, 24001, 24999, 24000],
    ['cz', 'Czech Republic', 'Europe', null, 26001, 26999, 26000],
    ['dk', 'Denmark', 'Europe', null, 27001, 27999, 27000],
    ['ee', 'Estonia', 'Europe', null, 28001, 28999, 28000],
    ['ch', 'Switzerland', 'Europe', null, 29001, 29999, 29000],
    ['mk', 'North Macedonia', 'Europe', null, 30001, 30999, 30000],
    ['cr', 'Costa Rica', 'Americas', null, 31001, 31999, 31000],
    ['cu', 'Cuba', 'Americas', null, 32001, 32999, 32000],
    ['al', 'Albania', 'Europe', null, 33001, 33999, 33000],
    ['ad', 'Andorra', 'Europe', null, 34001, 34999, 34000],
    ['at', 'Austria', 'Europe', null, 35001, 35999, 35000],
    ['ba', 'Bosnia and Herzegovina', 'Europe', null, 37001, 37999, 37000],
    ['bg', 'Bulgaria', 'Europe', null, 38001, 38999, 38000],
    ['by', 'Belarus', 'Europe', null, 39001, 39999, 39000],
    ['hr', 'Croatia', 'Europe', null, 40001, 40999, 40000],
    ['fi', 'Finland', 'Europe', null, 41001, 41099, 41000],
    ['hu', 'Hungary', 'Europe', null, 43001, 43999, 43000],
    ['qa', 'Qatar', 'Middle East', null, 44001, 44999, 44000],
    ['sa', 'Saudi Arabia', 'Middle East', null, 45001, 45999, 45000],
    ['vn', 'Vietnam', 'Asia', null, 46001, 46999, 46000],
    ['tm', 'Turkmenistan', 'Asia', null, 47001, 47999, 47000],
    ['uz', 'Uzbekistan', 'Asia', null, 48001, 48999, 48000],
    ['ye', 'Yemen', 'Middle East', null, 49001, 49999, 49000],
    ['cf', 'Central African Republic', 'Africa', null, 10001, 10999, 10000],
    ['td', 'Chad', 'Africa', null, 11001, 11999, 11000],
    ['bj', 'Benin', 'Africa', null, 12001, 12999, 12000],
    ['et', 'Ethiopia', 'Africa', null, 13001, 13999, 13000],
    ['dj', 'Djibouti', 'Africa', null, 14001, 14999, 14000],
    ['gm', 'Gambia', 'Africa', null, 15001, 15999, 15000],
    ['mr', 'Mauritania', 'Africa', null, 16001, 16999, 16000],
    ['mu', 'Mauritius', 'Africa', null, 17001, 17999, 17000],
    ['ao', 'Angola', 'Africa', null, 18001, 18999, 18000],
    ['cm', 'Cameroon', 'Africa', null, 19001, 19999, 19000],
    ['sy', 'Syria', 'Middle East', null, 20001, 20999, 20000],
];

function decodoHost(code, hostOverride) {
    if (hostOverride) return hostOverride;
    return `${code}.decodo.com`;
}

/** Port segment for URL template: rotating = fixed port, sticky = RAND in sticky range */
function decodoPortSegment(country, sessionMode) {
    if (sessionMode === 'sticky') {
        const min = country.stickyMin;
        const max = country.stickyMax;
        if (min === max) return String(min);
        return `{RAND:${min}-${max}}`;
    }
    return String(country.portRotating);
}

function buildDecodoCountries() {
    return DECODO_ENDPOINT_ROWS.map(([code, name, region, hostOverride, stickyMin, stickyMax, portRotating]) => {
        const host = decodoHost(code, hostOverride);
        return {
            code,
            name,
            region,
            host,
            stickyMin,
            stickyMax,
            portRotating,
            // legacy alias
            port: portRotating,
        };
    });
}

const DECODO_COUNTRIES = buildDecodoCountries();

const decodoApi = {
    DECODO_ENDPOINT_ROWS,
    DECODO_COUNTRIES,
    decodoHost,
    decodoPortSegment,
    buildDecodoCountries,
};

if (typeof window !== 'undefined') {
    window.cupnetDecodoEndpoints = decodoApi;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = decodoApi;
}
})();
