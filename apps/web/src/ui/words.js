// An amount in words in the Indian system (thousand, lakh, crore), as printed on a tax invoice: "Five thousand nine hundred and
// eighty-six rupees and fifty paise only". Pure and dependency-free so it can be tested from the API's test suite too.
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const below100 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} hundred` : '', r ? `${h ? 'and ' : ''}${below100(r)}` : ''].filter(Boolean).join(' ');
}

function wholeNumber(n) {
  if (n === 0) return 'zero';
  const parts = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1e3), rest = n % 1e3;
  if (crore) parts.push(`${wholeNumber(crore)} crore`);
  if (lakh) parts.push(`${below100(lakh)} lakh`);
  if (thousand) parts.push(`${below100(thousand)} thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function amountInWords(amount) {
  const paise = Math.round(Math.abs(Number(amount) || 0) * 100);
  const rupees = Math.floor(paise / 100), ps = paise % 100;
  const r = `${wholeNumber(rupees)} ${rupees === 1 ? 'rupee' : 'rupees'}`;
  return `${cap(r)}${ps ? ` and ${below100(ps)} paise` : ''} only`;
}
