// hashprobe.mjs     run:  JIOPAY_SECRET_KEY=yourSecret node hashprobe.mjs
import crypto from "crypto";

const secret = '3887cefccbfb4c1eb9ef7172b9ebc08b';
const payload = { "txnID": "7700230883725", "amount": "66080.00", "acqName": "PayPhi", "txnAuthID": "19971530940", "txnStatus": "SUC", "merchantId": "JP2001100068259", "oth_charge": false, "secureHash": "0aa6cf9ddb60f8bc201cdee6410a2e5baebafb6878e49f6211b2cec2adeb1e0a", "paymentMode": "NB", "responseCode": "000", "merchantTxnNo": "BBMD7020A04777D4BFA9", "customerEmailID": "raheelkhan.work@gmail.com", "paymentDateTime": "20261008175308", "respDescription": "Request processed successfully", "transactionType": "SALE", "txnResponseCode": "0000", "customerMobileNo": "9428545871", "paymentSubInstType": "HDFC Bank", "txnRespDescription": "Transaction successful", "TransmissionDateTime": "20261008175302" };

const { secureHash: target, ...rest } = payload;
const keys = Object.keys(rest);
const str = (v) => (v == null ? "" : String(v));

const orders = {
    "default sort": (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    "case-insensitive sort": (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()),
    "original order": null,
};

let found = 0;
for (const [name, cmp] of Object.entries(orders)) {
    for (let mask = 1; mask < 1 << keys.length; mask++) {
        const subset = keys.filter((_, i) => mask & (1 << i));
        const ordered = cmp ? [...subset].sort(cmp) : subset;
        const h = crypto.createHmac("sha256", secret)
            .update(ordered.map((k) => str(rest[k])).join(""), "utf8").digest("hex");
        if (h === target) {
            found++;
            console.log(`MATCH [${name}] excluded:`, keys.filter((k) => !subset.includes(k)));
        }
    }
}
console.log(found ? "done" : "NO MATCH");