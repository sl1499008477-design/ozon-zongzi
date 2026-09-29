import '../server/env.mjs';
import {getPostgresPool,closePostgresPool} from '../server/db/connection.mjs';
import {normalizeRestriction} from '../server/product-restrictions.mjs';
const pool=await getPostgresPool();
try{
 const actor=(await pool.query("SELECT id FROM accounts WHERE role='admin' AND status='active' ORDER BY created_at LIMIT 1")).rows[0];if(!actor)throw Error('需要管理员账号');
 const sourceUrl='https://global-help.ozon.com/zh/policies/product-rules-and-documents/product-rules/special-categories';
 const base={enabled:true,origin:'official',sourceUrl,verifiedAt:'2026-09-09',reason:'Ozon Global 中国卖家规则：电子烟、烟草加热设备及其配件禁止销售。'};
 const seeds=[
  {id:'official-ecig-charger',name:'电子烟充电器',categoryId:17028608,typeId:90669078,categoryLabel:'Зарядное устройство для электронных сигарет',action:'BLOCK'},
  {id:'official-heated-tobacco-accessory',name:'烟草加热系统配件',categoryId:17028608,typeId:971413556,categoryLabel:'Аксессуар для систем нагревания табака',action:'BLOCK'},
  {id:'official-ecig-accessory',name:'电子烟配件',categoryId:17028608,typeId:971412763,categoryLabel:'Аксессуар для электронных сигарет',action:'BLOCK'},
  {id:'official-tobacco-review',name:'烟草 / 电子烟疑似商品',keywords:['электронная сигарета','электронные сигареты','табак','电子烟','烟草'],action:'REVIEW',reason:'核实是否属于烟草、电子烟或烟草加热设备及配件；仅标题命中不能判定禁售。'},
  {id:'official-seeds-review',name:'活体植物与种子待核实',keywords:['семена','саженец','живое растение','种子','活体植物'],action:'REVIEW',reason:'核实是否为活体植物、种子、根茎或块茎；种植工具及装饰品不能直接认定禁售。'},
  {id:'official-medical-review',name:'医疗器械注册文件待核实',keywords:['медицинский прибор','медицинское изделие','医疗器械'],action:'REVIEW',reason:'医疗器械需要俄罗斯国家注册及注册证，确认产品性质及文件后再处理。'},
  {id:'official-supplement-review',name:'膳食补充剂认证待核实',keywords:['БАД','膳食补充剂'],action:'REVIEW',reason:'膳食补充剂需核实俄罗斯认证；标题命中仅提示，不等同已确认禁售。'},
  {id:'official-mercury-review',name:'水银温度计待核实',keywords:['ртутный термометр','水银温度计'],action:'REVIEW',reason:'水银温度计在禁售清单中，核实材料与类型；无汞温度计不能按此禁售。'},
 ];
 for(const seed of seeds){const {id,...body}=seed;await pool.query('INSERT INTO platform_product_restrictions(id,payload,updated_by) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[id,normalizeRestriction({...base,...body}),actor.id]);}
 console.log({seedRules:seeds.length,note:'3 exact type rules verified against live taxonomy; 5 keyword review rules. Existing rules are never overwritten.'});
}finally{await closePostgresPool();}
