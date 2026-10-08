// check-hash.mjs  — node check-hash.mjs
import crypto from "crypto";
const SECRET = '887cefccbfb4c1eb9ef7172b9ebc08b';

if (!SECRET) throw new Error("Set JIOPAY_SECRET_KEY first");
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s, "utf8").digest("hex");

// CONTROL: the return payload must match, or the secret/method is wrong.
const ret = {
    txnID: "7700230883725", amount: "66080.00", acqName: "PayPhi", paymentID: "19971530940",
    merchantId: "JP2001100068259", oth_charge: "false", paymentMode: "NB", responseCode: "0000",
    merchantTxnNo: "BBMD7020A04777D4BFA9", customerEmailID: "raheelkhan.work@gmail.com",
    paymentDateTime: "20261008175308", respDescription: "Transaction successful",
    customerMobileNo: "9428545871", paymentSubInstType: "HDFC Bank", TransmissionDateTime: "20261008175302",
};
const retHash = "8161a1bf4e835f00f0891b733b9aa90417915e6316657b61a8bbe8fa5f00843e";
console.log("CONTROL (return payload):",
    hmac(Object.keys(ret).sort().map((k) => ret[k]).join("")) === retHash ? "MATCH" : "NO MATCH -> secret is wrong");

// STATUS payload
const st = {
    txnID: "7700230883725", amount: "66080.00", acqName: "PayPhi", txnAuthID: "19971530940",
    txnStatus: "SUC", merchantId: "JP2001100068259", paymentMode: "NB",
    responseCode: "000", merchantTxnNo: "BBMD7020A04777D4BFA9", customerEmailID: "raheelkhan.work@gmail.com",
    paymentDateTime: "20261008175308", respDescription: "Request processed successfully",
    transactionType: "SALE", txnResponseCode: "0000", customerMobileNo: "9428545871",
    paymentSubInstType: "HDFC Bank", txnRespDescription: "Transaction successful",
    TransmissionDateTime: "20261008175302", oth_charge: "false",
};
const target = "0aa6cf9ddb60f8bc201cdee6410a2e5baebafb6878e49f6211b2cec2adeb1e0a";
const keys = Object.keys(st);
const sorts = {
    codeUnit: [...keys].sort(),
    caseInsensitive: [...keys].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
};
let found = 0;
for (const [sortName, order] of Object.entries(sorts)) {
    for (const oth of ["false", ""]) {
        for (let mask = 0; mask < 1 << keys.length; mask++) { // bit i set = field i excluded
            let s = "";
            for (const k of order) if (!(mask & (1 << keys.indexOf(k)))) s += k === "oth_charge" ? oth : st[k];
            if (hmac(s) === target) {
                found++;
                console.log("MATCH sort=%s oth_charge=%j excluded=[%s]", sortName, oth,
                    keys.filter((k, i) => mask & (1 << i)).join(","));
            }
        }
    }
}
console.log(found ? "done" : "no combination matched");