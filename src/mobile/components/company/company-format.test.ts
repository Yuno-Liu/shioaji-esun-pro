// 公司分頁的純函式：與桌面 company-panel.tsx 的 companyTarget／fmtTwd 用同一組案例（src/components/company-panel.test.ts），
// 外部連結只接受 http／https，關聯公司只有合法台股代碼可開交易頁。
import { describe, expect, it } from 'vitest';
import type { ContractInfo } from '../../../lib/types/contract';
import { companyTarget, externalHref, fmtGrowth, fmtK, fmtRatio, fmtTwd, siteText, tradableCodeOf } from './company-format';

const c = (fields: Partial<ContractInfo>) => fields as ContractInfo;

describe('companyTarget（同桌面規則）', () => {
    it('股票本身、個股期貨的標的；指數與指數期貨沒有', () => {
        expect(companyTarget(c({ security_type: 'STK', code: '2330' }))).toEqual({ code: '2330', viaUnderlying: false });
        expect(companyTarget(c({ security_type: 'FUT', code: 'CDFR1', underlying_code: '2330' }))).toEqual({ code: '2330', viaUnderlying: true });
        expect(companyTarget(c({ security_type: 'FUT', code: 'TXFR1', underlying_kind: 'I', underlying_code: '#001' }))).toBeNull();
        expect(companyTarget(c({ security_type: 'IND', code: '001' }))).toBeNull();
        // 沒有標的代碼的期權（商品期貨等）
        expect(companyTarget(c({ security_type: 'FUT', code: 'GDFR1' }))).toBeNull();
        // ETF 是股票型合約：交給資料集判斷（不在收錄範圍時顯示「此商品沒有公司資料」）
        expect(companyTarget(c({ security_type: 'STK', code: '0050' }))).toEqual({ code: '0050', viaUnderlying: false });
    });
});

describe('格式', () => {
    it('新台幣金額 兆／億／萬（同桌面）', () => {
        expect(fmtTwd(62.37e12)).toBe('62.37 兆');
        expect(fmtTwd(5.119e11)).toBe('5,119 億');
        expect(fmtTwd(3.5e8)).toBe('3.5 億');
        expect(fmtTwd(null)).toBe('—');
        expect(fmtK(511857399)).toBe('5,119 億');
        expect(fmtRatio(58.123)).toBe('58.1%');
        expect(fmtRatio(null)).toBe('—');
        expect(fmtGrowth(54.6486)).toBe('+54.6%');
        expect(fmtGrowth(-0.57)).toBe('-0.6%');
        expect(fmtGrowth(Number.NaN)).toBe('—');
    });
});

describe('externalHref：只接受 http／https', () => {
    it('補上 https、保留 http／https；拒絕其他通訊協定', () => {
        expect(externalHref('www.luckygrp.com.tw')).toBe('https://www.luckygrp.com.tw/');
        expect(externalHref('https://www.tsmc.com')).toBe('https://www.tsmc.com/');
        expect(externalHref('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
        expect(externalHref('javascript:alert(1)')).toBeNull();
        expect(externalHref('JavaScript:alert(1)')).toBeNull();
        expect(externalHref('data:text/html,hi')).toBeNull();
        expect(externalHref('mailto:a@b.c')).toBeNull();
        expect(externalHref('')).toBeNull();
        expect(externalHref(null)).toBeNull();
        expect(siteText('https://www.tsmc.com')).toBe('www.tsmc.com');
    });
});

describe('tradableCodeOf', () => {
    it('只有台股實體回傳代碼', () => {
        expect(tradableCodeOf('tw.2330')).toBe('2330');
        expect(tradableCodeOf('us.NVDA')).toBeNull();
        expect(tradableCodeOf('org.esmc')).toBeNull();
        expect(tradableCodeOf('tw.a b')).toBeNull();
    });
});
