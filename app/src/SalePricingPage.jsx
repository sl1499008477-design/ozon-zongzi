import React,{useEffect,useState} from 'react';
import {Alert,Button,Card,Empty,Form,Input,Modal,Popconfirm,Select,Space,Switch,Tag,Typography,message} from 'antd';
import Table from './PagedTable.jsx';
import {apiRequest} from './client-transport.js';
import {DEFAULT_REAL_PRICE_FORMULA,normalizeRealPricingRules,normalizeListingPricingRules,calculateRealPrice,calculateSalePrice,amountToSaleMinor,saleMinorToAmount,salePriceUsesRealPrice,displaySalePriceFormula} from '../../shared/sale-pricing.mjs';
const currencyName=code=>code==='CNY'?'人民币 CNY':'卢布 RUB';
const endpoint=kind=>kind==='real'?'/admin/real-pricing-profiles':'/ai-listing/pricing-profiles';
export function CompetitorPricingPage({account,...props}){
  if(account?.role!=='admin')return <Alert type="warning" showIcon message="仅管理员可管理竞品真实售价计算配置"/>;
  return <SalePricingPage {...props} kind="real"/>;
}
export default function SalePricingPage({request=apiRequest,kind='listing'}){
  const [items,setItems]=useState([]),[realItems,setRealItems]=useState([]),[loading,setLoading]=useState(false),[editing,setEditing]=useState(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const [form]=Form.useForm();const values=Form.useWatch([],form)||{};
  const [black,setBlack]=useState('106.92'),[green,setGreen]=useState('101.58'),[sourceMode,setSourceMode]=useState('tags');
  const defaultReal=realItems.find(item=>item.isDefault),isReal=editing?.kind==='real';
  const load=async()=>{setLoading(true);try{
    const result=await request(endpoint(kind));
    if(kind==='real')setRealItems(result.items||[]);
    else {setItems(result.items||[]);setRealItems(result.defaultRealPricing?[result.defaultRealPricing]:[]);}
    setError('');
  }catch(e){setError(e.message);}finally{setLoading(false);}};
  useEffect(()=>{void load();},[request,kind]);
  const edit=(kind,item)=>{setEditing({kind,...item});form.resetFields();form.setFieldsValue(item?{...item,...(kind==='listing'?{salePriceFormula:displaySalePriceFormula(item.salePriceFormula),useBlackPriceWhenGreenMissing:item.useBlackPriceWhenGreenMissing===true}:{})}:{name:'',currency:'CNY',...(kind==='real'?{realPriceFormula:DEFAULT_REAL_PRICE_FORMULA}:{salePriceFormula:'竞品真实售价计算',useBlackPriceWhenGreenMissing:false})});};
  const save=async()=>{try{
    const v=await form.validateFields(),rules=(isReal?normalizeRealPricingRules:normalizeListingPricingRules)(v);setSaving(true);
    await request(`${endpoint(editing.kind)}${editing.id?`/${editing.id}`:''}`,{method:editing.id?'PUT':'POST',body:{name:v.name,...rules,...(editing.id?{updatedAt:editing.updatedAt}:{})}});
    setEditing(null);message.success('配置已保存');await load();
  }catch(e){if(!e.errorFields)message.error(e.message);}finally{setSaving(false);}};
  const remove=async(kind,id)=>{try{await request(`${endpoint(kind)}/${id}`,{method:'DELETE'});message.success('配置已删除');await load();}catch(e){message.error(e.message);}};
  const makeDefault=async id=>{try{await request(`${endpoint('real')}/${id}/default`,{method:'PUT'});message.success('默认竞品真实售价计算配置已更新');await load();}catch(e){message.error(e.message);}};
  const operations=kind=>(_,item)=><Space wrap>
    <Button onClick={()=>edit(kind,item)}>编辑 / 试算</Button>
    {kind==='real'&&!item.isDefault&&<Button onClick={()=>makeDefault(item.id)}>设为默认</Button>}
    {!(kind==='real'&&item.isDefault)&&<Popconfirm title="删除这条配置？" description={kind==='real'?'这条非默认配置将被删除。':'之后创建任务需要重新选择配置；已有任务不受影响。'} onConfirm={()=>remove(kind,item.id)} okText="删除" cancelText="取消"><Button danger>删除</Button></Popconfirm>}
  </Space>;
  let preview,previewError='',usesReal=false;
  try{
    const input={currency:values.currency,...(sourceMode==='actual'?{sourcePriceKopecks:amountToSaleMinor(black)}:{blackKopecks:black.trim()?amountToSaleMinor(black):null,greenKopecks:green.trim()?amountToSaleMinor(green):null})};
    if(isReal)preview=calculateRealPrice(normalizeRealPricingRules(values),input);
    else{
      const rules=normalizeListingPricingRules(values);usesReal=salePriceUsesRealPrice(rules.salePriceFormula);
      preview=calculateSalePrice({...rules,pricingVersion:2,realPriceFormula:defaultReal?.realPriceFormula,realPricingCurrency:defaultReal?.currency},input);
    }
  }catch(e){previewError=e.message;}
  return <div className="ai-listing-page">
    <div className="ai-listing-page__header"><div><h1>{kind==='real'?'竞品真实售价计算':'售价配置'}</h1><p>{kind==='real'?'由管理员统一维护，所有账号使用同一个默认配置。已有任务保留创建时的公式。':'产品上架时选择上架售价配置；引用竞品真实售价计算时，使用管理员设置的全站默认公式。已有任务保留创建时的公式。'}</p></div></div>
    {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
    {kind==='real'?<Card title="竞品真实售价计算" extra={<Space wrap><Button onClick={load}>刷新</Button><Button type="primary" onClick={()=>edit('real')}>新增竞品真实售价计算配置</Button></Space>}>
      <Typography.Paragraph type="secondary">全站只有一个默认配置生效，其他配置仅供编辑和试算。Web、采集助手和扩展引用竞品真实售价计算结果时均使用此默认配置。</Typography.Paragraph>
      <Table rowKey="id" loading={loading} dataSource={realItems} columns={[
        {title:'配置名称',dataIndex:'name',width:200,render:(name,item)=><Space wrap>{name}{item.isDefault&&<Tag color="blue">默认 · 生效中</Tag>}</Space>},
        {title:'币种',dataIndex:'currency',width:115,render:currencyName},
        {title:'竞品真实售价计算公式',dataIndex:'realPriceFormula',render:value=><span style={{overflowWrap:'anywhere'}}>{value}</span>},
        {title:'操作',width:300,render:operations('real')},
      ]}/>
    </Card>:<Card title="产品上架售价计算" extra={<Space wrap><Button onClick={load}>刷新</Button><Button type="primary" onClick={()=>edit('listing')}>新增上架售价配置</Button></Space>}>
      <Typography.Paragraph type="secondary">决定上架至 Ozon 时填写的价格，在 AI 上架或采集助手的上架配置中选择使用。公式可以直接使用黑标价、绿标价，也可以引用当前默认竞品真实售价计算的结果。</Typography.Paragraph>
      <Table rowKey="id" loading={loading} dataSource={items} locale={{emptyText:<Empty description="暂无上架售价配置"/>}} columns={[
        {title:'配置名称',dataIndex:'name',width:200},
        {title:'币种',dataIndex:'currency',width:115,render:currencyName},
        {title:'上架售价公式',dataIndex:'salePriceFormula',render:value=><span style={{overflowWrap:'anywhere'}}>{displaySalePriceFormula(value)}</span>},
        {title:'操作',width:210,render:operations('listing')},
      ]}/>
    </Card>}
    <Modal title={`${editing?.id?'编辑':'新增'}${isReal?'竞品真实售价计算':'上架售价'}配置`} open={editing!==null} onCancel={()=>{if(!saving)setEditing(null);}} onOk={save} confirmLoading={saving} okText="保存配置" cancelText="取消" width={880}>
      <Form form={form} layout="vertical">
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:16}}>
          <Form.Item name="name" label="配置名称" rules={[{required:true,whitespace:true,message:'请输入配置名称'}]}><Input aria-label="售价配置名称" maxLength={80}/></Form.Item>
          <Form.Item name="currency" label="币种" rules={[{required:true}]}><Select aria-label="售价配置币种" options={['CNY','RUB'].map(value=>({value,label:currencyName(value)}))}/></Form.Item>
        </div>
        <Space wrap style={{marginBottom:14}}><span>公式模板：</span>
          {isReal?<><Button size="small" onClick={()=>form.setFieldsValue({realPriceFormula:DEFAULT_REAL_PRICE_FORMULA})}>原倒算规则</Button><Button size="small" onClick={()=>form.setFieldsValue({realPriceFormula:'(黑标价 - 绿标价) * 2.25 + 黑标价'})}>黑绿差价公式</Button><Button size="small" onClick={()=>form.setFieldsValue({realPriceFormula:'黑标价'})}>直接使用黑标价</Button></>:<><Button size="small" onClick={()=>form.setFieldsValue({salePriceFormula:'竞品真实售价计算'})}>引用默认竞品真实售价计算</Button><Button size="small" onClick={()=>form.setFieldsValue({salePriceFormula:'(竞品真实售价计算 + 10) * 1.2'})}>竞品真实售价计算加价</Button><Button size="small" onClick={()=>form.setFieldsValue({salePriceFormula:'黑标价'})}>直接使用黑标价</Button></>}
        </Space>
        {isReal?<Form.Item name="realPriceFormula" label="竞品真实售价计算公式" rules={[{required:true,message:'请输入竞品真实售价计算公式'}]}><Input.TextArea aria-label="竞品真实售价计算公式" autoSize={{minRows:2,maxRows:5}} maxLength={512}/></Form.Item>:<Form.Item name="salePriceFormula" label="上架售价公式" rules={[{required:true,message:'请输入上架售价公式'}]}><Input.TextArea aria-label="上架售价公式" autoSize={{minRows:2,maxRows:5}} maxLength={512}/></Form.Item>}
        {!isReal&&<Form.Item name="useBlackPriceWhenGreenMissing" valuePropName="checked" label="缺少绿标价时，使用黑标价计算" extra="开启：缺绿标价时，将竞品真实售价计算结果替换为本 SKU 黑标价，再执行上架售价公式。关闭：仅跳过缺绿标价的 SKU，同组其他 SKU 继续。已知实际原价不受此开关影响。"><Switch aria-label="缺少绿标价时使用黑标价计算" checkedChildren="开启" unCheckedChildren="关闭"/></Form.Item>}
        <Typography.Paragraph type="secondary">可用变量：黑标价、绿标价、有绿标价（有值为 1，无值为 0）{!isReal?'、竞品真实售价计算（仅引用默认配置）':''}。支持 + − × ÷、括号、比较符号和 IF(条件, 成立结果, 不成立结果)。</Typography.Paragraph>
        <Alert type="info" showIcon message={isReal?(editing?.isDefault?'当前为默认配置，保存后用于新的计算。':'此配置未生效。保存后可在列表中设为默认。'):(usesReal?`引用默认竞品真实售价计算：${defaultReal?.name||'正在读取'}（${defaultReal?.currency||''}）`:'此公式直接计算上架售价，不依赖竞品真实售价计算配置。')} description={isReal?'金额使用配置币种，四舍五入至两位小数。来源已有实际原价时直接使用，不再倒算。':usesReal?`竞品真实售价计算 = ${defaultReal?.realPriceFormula||''}。两种配置币种须一致，系统不会自动换汇。`:'已有任务、重试和恢复继续使用创建时的公式。'} style={{marginBottom:16}}/>
      </Form>
      <Card size="small" title="价格试算（不创建任务）">
        <Space wrap align="start">
          <label>来源类型<Select aria-label="试算来源类型" value={sourceMode} onChange={setSourceMode} style={{display:'flex',width:150}} options={[{value:'tags',label:'黑标 / 绿标价格'},{value:'actual',label:'已知实际原价'}]}/></label>
          <label>{sourceMode==='actual'?'实际原价':'黑标价'}<Input aria-label="试算黑标价" value={black} inputMode="decimal" onChange={e=>setBlack(e.target.value)} style={{display:'block',width:150}}/></label>
          {sourceMode==='tags'&&<label>绿标价（可留空）<Input aria-label="试算绿标价" value={green} inputMode="decimal" onChange={e=>setGreen(e.target.value)} style={{display:'block',width:150}}/></label>}
        </Space>
        <div aria-live="polite" style={{marginTop:16}}>{preview?<>{!isReal&&preview.realPriceKopecks!==null&&<span>{preview.usedBlackPriceFallback?'缺少绿标价，已采用黑标价计算':'默认竞品真实售价计算'}：{saleMinorToAmount(preview.realPriceKopecks)} {values.currency}</span>}<strong style={{display:'block',fontSize:22,color:'#005af8'}}>{isReal?'竞品真实售价计算':'上架售价'}：{saleMinorToAmount(isReal?preview.realPriceKopecks:preview.finalPriceKopecks)} {values.currency}</strong></>:<Alert type="warning" showIcon message={previewError}/>}</div>
      </Card>
    </Modal>
  </div>;
}
