import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOrderPosting,orderPostingView} from '../order-management-money.mjs';
import {createOrderManagementOzon} from '../order-management-ozon.mjs';

const posting=(overrides={})=>({posting_number:'one-1-1',order_number:'one-1',status:'delivered',in_process_at:'2026-09-10T10:00:00Z',
  products:[{sku:11,offer_id:'offer',name:'商品',quantity:3,price:{amount:'220',currency:'CNY'}}],
  financial_data:{products:[{product_id:11,price:220,quantity:3,commission:{amount:-1065.12,currency:'RUB',percent:14},payout:6542.88}]},...overrides});

test('real mixed-currency multi-quantity posting retains total commission, never invents payout currency or FX',()=>{
  const base=normalizeOrderPosting(posting(),'FBS');
  const view=orderPostingView(base,{'11':{unitCostCny:'90.01',costSource:'MANUAL'}});
  assert.deepEqual(view.sale,{amount:'660.00',currency:'CNY'});
  assert.deepEqual(view.commission,{amount:'-1065.12',currency:'RUB'});
  assert.deepEqual(view.payout,{amount:'6542.88',currency:null});
  assert.equal(view.purchaseCostCny,'270.03');assert.equal(view.grossProfitCny,null);
  assert.match(view.profitUnavailableReason,/币种|汇率/);assert.equal(view.commissionMatch,'MATCHED');
});

test('exact CNY gross margin uses actual commission and manual zero or null without floating arithmetic',()=>{
  const raw=posting({products:[{sku:11,quantity:3,price:{amount:'0.10',currency:'CNY'}}],financial_data:{products:[{product_id:11,price:0.10,commission:{amount:-0.03,currency:'CNY'},payout:0.27}]}});
  const base=normalizeOrderPosting(raw,'FBO');
  assert.equal(orderPostingView(base,{'11':{unitCostCny:'0.01',costSource:'MANUAL'}}).grossProfitCny,'0.24');
  assert.equal(orderPostingView(base,{'11':{unitCostCny:'0.00',costSource:'MANUAL'}}).grossProfitCny,'0.27');
  assert.equal(orderPostingView(base,{'11':{unitCostCny:null,costSource:'MANUAL'}}).grossProfitCny,null);
  assert.equal(orderPostingView(base,{}).products[0].costSource,null);
});

test('legacy database rows remain readable and missing financial fields do not become zero',()=>{
  const raw=posting({products:[{sku:'11',quantity:2,name:'旧商品',price:'900719925474.11',currency_code:'CNY'}],financial_data:{products:[{product_id:11,commission_amount:'0.12',commissions_currency_code:'CNY',currency_code:'CNY',price:'900719925474.11'}]}});
  const view=orderPostingView(normalizeOrderPosting(raw,'FBS'),{'11':{unitCostCny:'0.10',costSource:'PRODUCT_AUTO'}});
  assert.equal(view.sale.amount,'1801439850948.22');assert.equal(view.grossProfitCny,'1801439850947.90');
  raw.financial_data.products=[];
  const missing=orderPostingView(normalizeOrderPosting(raw,'FBS'),{});
  assert.equal(missing.commission,null);assert.equal(missing.commissionMatch,'MISSING');assert.equal(missing.payout,null);
  assert.doesNotThrow(()=>normalizeOrderPosting({posting_number:'historical',products:[{name:'旧数据'}]},'FBS'));
});

test('SKU identity matches finance independently of array order; mixed currencies and unknown statuses survive',()=>{
  const raw=posting({status:'client_arbitration',integration_type_flow:'hybrid_3pl_tracking',products:[{sku:11,quantity:1,price:{amount:'20',currency:'CNY'}},{sku:22,quantity:1,price:{amount:'30',currency:'RUB'}}],financial_data:{products:[{product_id:22,commission:{amount:4,currency:'RUB'}},{product_id:11,commission:{amount:3,currency:'CNY'}}]}});
  const view=orderPostingView(normalizeOrderPosting(raw,'FBS'),{});
  assert.equal(view.scheme,'rFBS');assert.equal(view.statusGroup,'disputed');assert.equal(view.sale,null);assert.equal(view.commission,null);
  assert.equal(view.products[0].commission.amount,'3.00');assert.equal(view.products[1].commission.amount,'4.00');
  assert.equal(normalizeOrderPosting({...raw,status:'new_platform_state'},'FBS').statusGroup,'other');
});

test('current Ozon cursor endpoints request financial data, preserve all pages and reject broken continuation',async()=>{
  const calls=[];
  const ozon=createOrderManagementOzon({callApi:async(store,path,body)=>{calls.push({path,body});return {postings:[posting()],cursor:'next',has_next:true}}});
  const result=await ozon.listPostings({},'FBS',{since:'2026-09-01T00:00:00Z',to:'2026-09-11T00:00:00Z'});
  assert.equal(result.postings[0].sale.amount,'660.00');assert.equal(result.hasNext,true);
  await ozon.listPostings({},'FBO',{since:'2026-09-01T00:00:00Z',to:'2026-09-11T00:00:00Z',cursor:'previous'});
  assert.deepEqual(calls.map(c=>c.path),['/v4/posting/fbs/list','/v3/posting/fbo/list']);
  assert.ok(calls.every(c=>c.body.with.financial_data===true&&c.body.limit===100));
  assert.equal(calls[1].body.cursor,'previous');
  const broken=createOrderManagementOzon({callApi:async()=>({postings:[posting()],cursor:'same',has_next:true})});
  await assert.rejects(broken.listPostings({},'FBS',{cursor:'same'}),e=>e.code==='ORDER_MANAGEMENT_INVALID_RESPONSE');
});

test('cancelled orders never report gross profit even when CNY sale, commission and costs are complete',()=>{
  const raw=posting({status:'cancelled',products:[{sku:11,quantity:2,price:{amount:'20.10',currency:'CNY'}}],financial_data:{products:[{product_id:11,commission:{amount:-4.02,currency:'CNY'}}]}});
  const view=orderPostingView(normalizeOrderPosting(raw,'FBS'),{'11':{unitCostCny:'5.01',costSource:'MANUAL'}});
  assert.equal(view.purchaseCostCny,'10.02');assert.equal(view.commission.amount,'-4.02');
  assert.equal(view.grossProfitCny,null);assert.equal(view.profitUnavailableReason,'取消订单不计利润');
});
