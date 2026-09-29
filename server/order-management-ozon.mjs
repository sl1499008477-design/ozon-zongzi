import {callOzonSellerApi} from './ozon-client.mjs';
import {normalizeOrderPosting} from './order-management-money.mjs';

const invalid=()=>Object.assign(new Error('Ozon 订单响应或分页游标无效，未标记同步完成'),{status:502,code:'ORDER_MANAGEMENT_INVALID_RESPONSE'});

// Official Seller API, checked 2026-09-11:
// https://docs.ozon.ru/api/seller/#operation/PostingFbsList
// https://docs.ozon.ru/api/seller/#operation/PostingFboList
// These POST methods only read orders. No fulfillment or messaging API is used.
export function createOrderManagementOzon({callApi=callOzonSellerApi}={}){
  return {
    async listPostings(store,scheme,{since,to,cursor=''}={}){
      const response=await callApi(store,scheme==='FBO'?'/v3/posting/fbo/list':'/v4/posting/fbs/list',{
        cursor,filter:{since,to},limit:100,sort_dir:'ASC',translit:false,
        with:{analytics_data:false,financial_data:true},
      },30000,{maxResponseBytes:8*1024*1024});
      if(!Array.isArray(response?.postings)||typeof response.has_next!=='boolean'
        ||response.has_next&&(!response.cursor||response.cursor===cursor||!response.postings.length))throw invalid();
      const postings=response.postings.map(raw=>{
        if(typeof raw?.posting_number!=='string'||!raw.posting_number.trim()||!Array.isArray(raw.products))throw invalid();
        const posting=normalizeOrderPosting(raw,scheme);
        if(posting.products.some(p=>!p.sku||p.quantity===null)||new Set(posting.products.map(p=>p.sku)).size!==posting.products.length)throw invalid();
        return posting;
      });
      return {postings,cursor:response.cursor||'',hasNext:response.has_next};
    },
  };
}
