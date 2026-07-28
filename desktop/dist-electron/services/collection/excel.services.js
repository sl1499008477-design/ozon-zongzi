import { ExcelWriter } from '../../utils/excel.js';
import { join } from 'path';
import { SysTemUtils } from '../../utils/system.js';
import log from '../../log/index.js';
const excelDir = join(SysTemUtils.getAppInfo().userDataPath, 'excel');
export class ExcelService {
    excel = null;
    isInit = false;
    constructor(tableName) {
        this.excel = new ExcelWriter(join(excelDir, `${tableName}.xlsx`));
    }
    // 初始化表格
    async initTable() {
        if (this.isInit || !this.excel)
            return;
        try {
            // 定义所有列
            const columns = [
                // 基础信息
                { header: '商品ID', key: 'id', width: 15 },
                { header: '商品链接', key: 'link', width: 30 },
                { header: '商品主图', key: 'cover', width: 20 },
                { header: '商品名称', key: 'nameLabel', width: 30 },
                { header: '商品名称（中文）', key: 'chineseName', width: 30 },
                { header: '商品类目', key: 'category3', width: 20 },
                { header: '类目佣金（RFBS）', key: 'commissionRfbs', width: 15 },
                { header: '类目佣金（FBP）', key: 'commissionFbp', width: 15 },
                { header: '品牌', key: 'brand', width: 20 },
                { header: '销售价格（₽）', key: 'price', width: 15 },
                { header: '原价（₽）', key: 'oPrice', width: 15 },
                { header: '商品评分', key: 'rating', width: 10 },
                { header: '评价次数', key: 'reviewCountLabel', width: 10 },
                { header: '跟卖人数', key: 'sellerNumber', width: 10 },
                { header: '跟卖最低价', key: 'followMinPrice', width: 15 },
                { header: '商品创建日期', key: 'nullableCreateDate', width: 15 },
                { header: '上架时间（天）', key: 'releaseDate', width: 15 },
                { header: '发货模式', key: 'salesSchema', width: 15 },
                // 销售数据
                { header: '月销售额(₽)', key: 'gmvSum', width: 15 },
                { header: '月销售动态(%)', key: 'salesDynamics', width: 15 },
                { header: '月销量(件)', key: 'soldCount', width: 10 },
                { header: '平均日销售额(₽)', key: 'avgGmvOnAccDays', width: 15 },
                { header: '平均日销量(件)', key: 'avgOrdersOnAccDays', width: 10 },
                { header: '搜索和目录浏览量', key: 'sessionCountSearch', width: 15 },
                { header: '商品卡片浏览量', key: 'sessionCount', width: 15 },
                { header: '搜索和目录加购率(%)', key: 'convToCartSearch', width: 15 },
                { header: '商品卡片加购率(%)', key: 'convToCartPdp', width: 15 },
                { header: '广告份额（%）', key: 'drr', width: 10 },
                { header: '参与促销天数', key: 'daysInPromo', width: 12 },
                { header: '参与促销折扣(%)', key: 'discount', width: 15 },
                { header: '促销活动的转化率(%)', key: 'promoRevenueShare', width: 15 },
                { header: '付费推广天数', key: 'daysWithTrafarets', width: 12 },
                { header: '平均价格(₽)', key: 'avgPrice', width: 15 },
                { header: '已错过销售(₽)', key: 'sumMissedGmv', width: 15 },
                { header: '商品可用性(%)', key: 'accessibility', width: 15 },
                // 物流信息
                { header: '配送时间（天）', key: 'avgDeliveryDays', width: 12 },
                { header: '商品体积（升）', key: 'volume', width: 12 },
                { header: '包装长(mm)', key: 'length', width: 12 },
                { header: '包装宽(mm)', key: 'width', width: 12 },
                { header: '包装高(mm)', key: 'height', width: 12 },
                { header: '包装重量(g)', key: 'weight', width: 12 },
                // 成本和利润
                { header: 'RFBS佣金(元)', key: 'fbsPrice', width: 15 },
                { header: '国际物流', key: 'internalExpress', width: 15 },
                { header: '国际物流费用（元）', key: 'logisticsMoney', width: 15 },
                { header: '尾程派送费', key: 'endDeliveryFee', width: 15 },
                { header: '国内运费（元）', key: 'rubExpressPrice', width: 15 },
                { header: '其他费用（提现、货损）（元）', key: 'elsePrice', width: 20 },
                { header: '货源地址', key: '1688link', width: 30 },
                { header: '货源图片', key: 'cover2', width: 20 },
                { header: '商品主图', key: 'cover3', width: 20 },
                { header: '货源价格（元）', key: 'sourcePrice', width: 15 },
                { header: '货源备注', key: 'sourceRemark', width: 20 },
                { header: '我的售价（元）', key: 'resMoney', width: 15 },
                { header: '预期售价（元）', key: 'estimateMoney', width: 15 },
                { header: '预期售价（卢布）', key: 'estimateMoneyRub', width: 15 },
                { header: '我的利润率（%）', key: 'myActualProfitPercent', width: 15 },
                { header: '我的利润（元）', key: 'myProfit', width: 15 },
                { header: '对方销售价格（₽）', key: 'price1', width: 15 },
                { header: '对方原价（₽）', key: 'oPrice1', width: 15 },
                { header: '跟卖最低价', key: 'followMinPrice1', width: 15 },
                { header: '跟卖人数', key: 'sellerNumber1', width: 10 },
                { header: '对方利润率（%）', key: 'otherProfitPercent', width: 15 },
                { header: '对方利润（元）', key: 'otherProfit', width: 15 },
                // 对方信息
                /*         { header: '对方佣金（元）', key: 'otherFbsPrice', width: 15 },
                        { header: '对方其他费用（元）', key: 'otherElsePrice', width: 15 },
                        { header: '对方尾程派送费（元）', key: 'otherEndDeliveryPrice', width: 15 },
                        { header: '对方总成本（元）', key: 'otherCost', width: 15 },
                        { header: '对方人民币售价（元）', key: 'ozonPriceCny', width: 15 },
                        { header: '汇率（卢布 => 人民币）', key: 'rmbToRub', width: 15 },
                        { header: '对方物流费用（元）', key: 'otherLogisticsMoney', width: 15 } */
            ];
            // 首先设置列定义
            await this.excel.init();
            // 检查是否已有列定义（即是否已有表头）
            const worksheet = this.excel.getWorksheet();
            const hasHeaders = worksheet.getRow(1).values && worksheet.getRow(1).values.length;
            if (!hasHeaders) {
                // 没有表头，设置列定义和表头
                this.excel.setColumns(columns);
                // 在第一行插入主类别标题
                const mainCategoryRowValues = Array(columns.length).fill('');
                worksheet.spliceRows(1, 0, mainCategoryRowValues);
                // 设置主类别标题
                worksheet.getCell('A1').value = '基础信息';
                worksheet.getCell('R1').value = '销售数据';
                worksheet.getCell('AJ1').value = '尺寸重量';
                worksheet.getCell('AO1').value = '我的定价';
                // 合并单元格
                this.excel.mergeCells('A1:Q1');
                this.excel.mergeCells('R1:AI1');
                this.excel.mergeCells('AJ1:AN1');
                this.excel.mergeCells('AO1:BK1');
                // 设置表头样式 - 只设置第1行（主类别标题）
                this.excel.setRowStyle(1, {
                    font: { bold: true, size: 12 },
                    alignment: { vertical: 'middle', horizontal: 'center' },
                    fill: {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'fff3ca' },
                    },
                    border: {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' },
                    },
                });
                // 设置第2行作为具体列标题行
                const headerRow = worksheet.getRow(2);
                columns.forEach((col, index) => {
                    headerRow.getCell(index + 1).value = col.header;
                });
                this.excel.setRowStyle(2, {
                    font: { bold: true, size: 10 },
                    alignment: { vertical: 'middle', horizontal: 'center' },
                    fill: {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'd9d9d9' },
                    },
                    border: {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' },
                    },
                });
                log.info('Excel 表头初始化完成');
                this.isInit = true;
            }
            else {
                log.info('Excel 表头已存在，跳过初始化');
            }
        }
        catch (error) {
            log.error('初始化 Excel 表头失败:', error);
        }
    }
    async saveExcel(data) {
        try {
            if (!this.isInit)
                await this.initTable();
            return await this.excel?.appendAndSave(data);
        }
        catch (error) {
            log.error('写入Excel 失败！');
            return false;
        }
    }
    async flushToDisk() {
        this.excel?.flushToDisk();
    }
    async getFilePath() {
        return this.excel?.getFilePath() || '';
    }
    async DeleteFilled() {
        await SysTemUtils.fileOperations.deleteFile(await this.getFilePath());
    }
    destroy() {
        this.excel = null;
    }
}
