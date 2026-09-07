/**
 * End-to-end check of the model path using invented cargo data, so no customer
 * document is sent. Confirms the request shape, schema and parsing all work.
 */
import { gemini } from '../lib/llm/provider.ts';

const FAKE_BL = `ACME WIDGET MANUFACTURING CO., LTD
88 EXAMPLE ROAD, TESTVILLE, FAKELAND
BRIGHTSIDE TRADING SDN BHD
(199901234567/ TR9999999-X)
NO 12 JALAN CONTOH 5/9,
TAMAN PERCUBAAN,
40000 SHAH ALAM SELANGOR
TEL/ FAX : +60 3-1234 5678
SAME AS CONSIGNEE
DUMMYPORT
EVER EXAMPLE 999/E001DUMMYPORT
WEST PORT WEST PORT WEST PORT
N/MSHIPPER'S LOAD,COUNT & SEAL1234.500KGS12.750CBM
(1*20'GP)CONTAINER S.T.C.
250CARTONS
WIDGETS
SPROCKETS
CONTAINER/SEAL NO.:
TEST1234567/20'GP/SEAL987654/250CARTONS/1234.500KGS/12.750CBM
SAY TWO HUNDRED FIFTY CARTONS ONLY
FREIGHT COLLECT`;

const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const started = Date.now();
const got = await gemini(process.env.GEMINI_API_KEY!, model).extract({
  kind: 'BL',
  text: FAKE_BL,
  wanted: ['consignee', 'portOfDischarge', 'packages', 'grossWeight', 'measurement', 'goods', 'freightTerms', 'containerNo'],
});
console.log(`model: ${model}   round trip: ${Date.now() - started}ms\n`);

const EXPECT: Record<string, RegExp> = {
  consignee: /BRIGHTSIDE TRADING SDN BHD/,
  portOfDischarge: /WEST PORT/i,
  packages: /250/,
  grossWeight: /1234\.5/,
  measurement: /12\.75/,
  goods: /WIDGETS/i,
  freightTerms: /COLLECT/i,
  containerNo: /TEST1234567/,
};
let bad = 0;
for (const [k, re] of Object.entries(EXPECT)) {
  const v = got[k as keyof typeof got];
  const ok = typeof v === 'string' && re.test(v);
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(16)} ${JSON.stringify(v ?? null)}`);
}
console.log(bad ? `\n${bad} field(s) wrong.` : '\nAll fields extracted correctly.');
