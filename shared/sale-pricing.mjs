// Shared by the server, Web preview and the packaged browser extension.
export const DEFAULT_REAL_PRICE_FORMULA = 'IF(黑标价 < 80, 黑标价 / 1.0715, IF(有绿标价, (黑标价 - 绿标价) * 2.25 + 黑标价, 黑标价))';
export const DEFAULT_SALE_PRICE_FORMULA = '(真实售价 + 0) * 1';
const MAX_MINOR = 9_223_372_036_854_775_807n;
const fail = (code, message) => Object.assign(new Error(message), {code, status:422, statusCode:422});
const syntax = message => fail('SALE_PRICING_FORMULA_INVALID', message);
const symbols = {'（':'(', '）':')', '＋':'+', '−':'-', '－':'-', '×':'*', '÷':'/', '，':','};
const clean = value => typeof value === 'string' ? value.trim().replaceAll('竞品真实售价计算','真实售价').replace(/[（）＋−－×÷，]/g, c=>symbols[c]) : '';
// Keep the stored variable stable for existing tasks and older clients.
export const displaySalePriceFormula = value => String(value??'').replace(/竞品真实售价计算|真实售价/g,'竞品真实售价计算');
const abs = n => n < 0n ? -n : n;
function fraction(n, d=1n) {
  if (!d) throw fail('SALE_PRICING_DIVISION_BY_ZERO','公式中出现除以 0，请修改公式或价格输入');
  if (d<0n) {n=-n;d=-d;}
  if (abs(n).toString().length>120 || d.toString().length>120) throw fail('PRICE_INPUT_INVALID','公式计算结果超出有效范围');
  let a=abs(n),b=d;while(b){const next=a%b;a=b;b=next;}
  return {n:n/a,d:d/a};
}
function decimal(text) {
  const [whole,part='']=text.split('.');return fraction(BigInt(whole+part),10n**BigInt(part.length));
}
function parse(text, allowReal) {
  if (!text || text.length>512) throw syntax('公式须为 1～512 字');
  const tokens=[];let index=0;
  while(index<text.length){
    if(/\s/.test(text[index])){index++;continue;}
    const match=/^(\d+(?:\.\d+)?|[A-Za-z_\u4e00-\u9fff]+|<=|>=|==|!=|[+*/(),<>-])/.exec(text.slice(index));
    if(!match)throw syntax(`公式含不支持的字符：${text[index]}`);
    tokens.push(match[0]);index+=match[0].length;
    if(tokens.length>160)throw syntax('公式过长，请简化');
  }
  let at=0,depth=0;
  const take=expected=>{if(tokens[at++]!==expected)throw syntax(`公式缺少 ${expected}`);};
  const vars=new Set(['黑标价','绿标价','有绿标价',...(allowReal?['真实售价']:[])]);
  const precedence={'==':1,'!=':1,'<':1,'>':1,'<=':1,'>=':1,'+':2,'-':2,'*':3,'/':3};
  function expression(min=0){
    if(++depth>32)throw syntax('公式括号层数过多');
    const token=tokens[at++];let left;
    if(token==='-'||token==='+')left={unary:token,value:expression(4)};
    else if(token==='('){left=expression();take(')');}
    else if(token==='IF'){
      take('(');const condition=expression();take(',');const yes=expression();take(',');const no=expression();take(')');
      left={condition,yes,no};
    }else if(token&&/^\d/.test(token)){
      if(!/^\d{1,18}(?:\.\d{1,8})?$/.test(token))throw syntax('常数最多 18 位整数和 8 位小数');
      left={number:decimal(token)};
    }else if(vars.has(token))left={variable:token};
    else throw syntax(`无法识别公式中的 ${token||'空白'}，请使用价格变量、数字和运算符`);
    while(precedence[tokens[at]]>=min){
      const operator=tokens[at++];left={operator,left,right:expression(precedence[operator]+1)};
    }
    depth--;return left;
  }
  const ast=expression();if(at!==tokens.length)throw syntax(`公式中多出 ${tokens[at]}`);return ast;
}
function evaluate(ast, variables){
  if(ast.number)return ast.number;
  if(ast.variable){
    const value=variables[ast.variable];
    if(value==null)throw fail('SALE_PRICING_INPUT_MISSING',`缺少${ast.variable}，无法按此公式计算`);
    return value;
  }
  if(ast.condition)return evaluate(evaluate(ast.condition,variables).n!==0n?ast.yes:ast.no,variables);
  if(ast.unary){const v=evaluate(ast.value,variables);return ast.unary==='-'?fraction(-v.n,v.d):v;}
  const a=evaluate(ast.left,variables),b=evaluate(ast.right,variables);
  const left=a.n*b.d,right=b.n*a.d;
  switch(ast.operator){
    case '+':return fraction(left+right,a.d*b.d);
    case '-':return fraction(left-right,a.d*b.d);
    case '*':return fraction(a.n*b.n,a.d*b.d);
    case '/':return fraction(a.n*b.d,a.d*b.n);
    default:return fraction(BigInt({'==':left===right,'!=':left!==right,'<':left<right,'>':left>right,'<=':left<=right,'>=':left>=right}[ast.operator]));
  }
}
function currencyRule(currency){
  if(!['CNY','RUB'].includes(currency))throw fail('SALE_PRICING_CURRENCY_INVALID','请选择人民币或卢布');
  return currency;
}
export function normalizeRealPricingRules(raw={}){
  const realPriceFormula=clean(raw.realPriceFormula);parse(realPriceFormula,false);
  return {currency:currencyRule(raw.currency),realPriceFormula};
}
export function normalizeListingPricingRules(raw={}){
  const salePriceFormula=clean(raw.salePriceFormula);parse(salePriceFormula,true);
  if(raw.useBlackPriceWhenGreenMissing!==undefined&&typeof raw.useBlackPriceWhenGreenMissing!=='boolean')throw fail('SALE_PRICING_FALLBACK_INVALID','缺少绿标价时使用黑标价的设置须为开启或关闭');
  return {currency:currencyRule(raw.currency),salePriceFormula,useBlackPriceWhenGreenMissing:raw.useBlackPriceWhenGreenMissing===true};
}
export function normalizeSalePricingRules(raw={}){
  return {...normalizeRealPricingRules(raw),...normalizeListingPricingRules(raw)};
}
export function salePriceUsesRealPrice(formula){
  const visit=ast=>ast.variable==='真实售价'||Object.values(ast).some(value=>value&&typeof value==='object'&&visit(value));
  return visit(parse(clean(formula),true));
}
export function amountToSaleMinor(value){
  const text=String(value??'').trim();
  if(!/^\d{1,17}(?:\.\d{1,2})?$/.test(text))throw fail('PRICE_INPUT_INVALID','价格须为正数，最多两位小数');
  const [whole,part='']=text.split('.');return String(BigInt(whole)*100n+BigInt(part.padEnd(2,'0')));
}
export function saleMinorToAmount(value){
  const n=BigInt(value);return `${n<0n?'-':''}${abs(n)/100n}.${String(abs(n)%100n).padStart(2,'0')}`;
}
function minor(value, required=false){
  if(value==null||value===''){
    if(required)throw fail('SALE_PRICING_INPUT_MISSING','缺少商品价格');return null;
  }
  if(!/^\d{1,19}$/.test(String(value)))throw fail('PRICE_INPUT_INVALID','商品价格无效');
  const n=BigInt(value);if(n<=0n||n>MAX_MINOR)throw fail('PRICE_INPUT_INVALID','商品价格须大于 0 且在有效范围内');
  return fraction(n,100n);
}
function roundedMinor(value){
  const n=(abs(value.n)*100n*2n+value.d)/(value.d*2n)*(value.n<0n?-1n:1n);
  if(abs(n)>MAX_MINOR)throw fail('PRICE_INPUT_INVALID','公式计算结果超出有效范围');return n;
}
function priceVariables(input){
  return {
    get 黑标价(){return minor(input.blackKopecks??input.sourcePriceKopecks,true);},
    get 绿标价(){
      const green=minor(input.greenKopecks);
      if(green){const black=this.黑标价;if(green.n*black.d>black.n*green.d)throw fail('PRICE_INPUT_INVALID','绿标价不能高于黑标价');}
      return green;
    },
    '有绿标价':fraction(input.greenKopecks!=null&&input.greenKopecks!==''?1n:0n),
  };
}
function checkCurrency(rules,input){
  if(input.currency!==rules.currency)throw fail('SALE_PRICING_CURRENCY_MISMATCH','售价配置币种与商品 / 店铺币种不一致，请重新选择配置');
}
export function calculateRealPrice(rules,input){
  checkCurrency(rules,input);
  const real=roundedMinor(input.sourcePriceKopecks!=null?minor(input.sourcePriceKopecks,true):evaluate(parse(clean(rules.realPriceFormula),false),priceVariables(input)));
  if(real<=0n)throw fail('PRICE_FINAL_NOT_POSITIVE','竞品真实售价计算结果不大于 0');
  return {currency:rules.currency,realPriceKopecks:String(real)};
}
export function calculateSalePrice(rules,input){
  checkCurrency(rules,input);
  // Only explicit new policies affect tag prices. Historical snapshots and known actual prices retain their semantics.
  const missingGreenPolicy=typeof rules.useBlackPriceWhenGreenMissing==='boolean'&&(input.sourcePriceKopecks==null||input.sourcePriceKopecks==='')&&(input.greenKopecks==null||input.greenKopecks==='');
  if(missingGreenPolicy){
    const reason=!rules.useBlackPriceWhenGreenMissing?'GREEN_PRICE_MISSING':input.blackKopecks==null||input.blackKopecks===''?'BLACK_PRICE_MISSING':null;
    if(reason)throw Object.assign(fail('SALE_PRICING_SKU_SKIPPED',reason==='GREEN_PRICE_MISSING'?'缺少绿标价，当前配置已关闭黑标价替代，仅跳过此 SKU':'缺少绿标价且黑标价不可用，仅跳过此 SKU'),{skipReason:reason,details:{skipReason:reason}});
    minor(input.blackKopecks,true);
  }
  const variables=priceVariables(input);let real=null;
  const readReal=()=>{
    if(real===null){
      const realRules={...rules,currency:rules.realPricingCurrency||rules.currency};
      checkCurrency(realRules,input);
      real=missingGreenPolicy?BigInt(input.blackKopecks):BigInt(calculateRealPrice(realRules,input).realPriceKopecks);
    }
    return fraction(real,100n);
  };
  // Old task snapshots retain eager evaluation; new independent listing rules are lazy.
  if(rules.pricingVersion!==2)readReal();
  Object.defineProperty(variables,'真实售价',{get:readReal});
  const final=roundedMinor(evaluate(parse(clean(rules.salePriceFormula),true),variables));
  if(final<=0n)throw fail('PRICE_FINAL_NOT_POSITIVE','公式计算后的售价不大于 0');
  return {currency:rules.currency,branch:'SALE_PRICING_PROFILE',realPriceKopecks:real===null?null:String(real),finalPriceKopecks:String(final),
    ...(missingGreenPolicy&&real!==null?{priceBasis:'BLACK_PRICE_FALLBACK',usedBlackPriceFallback:true}:{})};
}
