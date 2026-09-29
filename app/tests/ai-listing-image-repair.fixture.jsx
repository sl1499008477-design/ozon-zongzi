import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AiListingTaskTable} from '../src/AiListingPage.jsx';
const task={id:'image-failure',version:1,sku:'4453873642',name:'Напольные светильники,Торшер',status:'SUBMISSION_FAILED',submissionStage:'image_failed',
 createdAt:'2026-09-16T05:31:18Z',updatedAt:'2026-09-16T05:31:18Z',config:{},taskActions:{retry:true,delete:true},
 images:[],progress:{completed:78,total:78},submissionResults:[
 {sku:'4453873642',offerId:'jz-4453873642',importStatus:'SUCCEEDED',stockStatus:'COMPLETED'},
 {sku:'4453874197',offerId:'jz-4453874197-09',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'IMAGE_FAILED',failureReason:'Ozon 图片接收失败；重试仅重传本 SKU 的完整图片组'}]};
let current=task;const request=async()=>({task:current});
function App(){const [row,setRow]=useState(task);const act=async(_,kind)=>{window.calls.push(kind);current={...row,status:'SUBMITTED',submissionStage:'repairing_images',taskActions:{},submissionResults:row.submissionResults.map(r=>r.publicationStatus?{...r,stockStatus:'PENDING',publicationStatus:'IMAGE_REPAIR_PENDING',failureReason:'',statusMessage:'图片已进入重传流程'}:r)};setRow(current);return current;};return <main style={{padding:24}}><h1>图片恢复验收</h1><AiListingTaskTable tasks={[row]} request={request} onAction={act}/></main>;}
window.calls=[];createRoot(document.getElementById('root')).render(<App/>);
