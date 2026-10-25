// src/components/header-env-menu.css.ts — 頂欄「券商／帳號／環境」選單（fork 專屬樣式）
// 徽章本體沿用上游 hud-header.css 的 simBadge／prodBadge，這裡只疊加可點擊的互動樣式；
// 所有顏色都走 theme token，淺色／深色主題下對比一致。

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
});

// 疊加在上游 simBadge／prodBadge／unknownBadge 上：按鈕重設與 hover
export const badgeButton = style({
    cursor: 'pointer',
    gap: '4px',
    transition: 'filter 0.12s, border-color 0.12s',
    ':hover': {
        filter: 'brightness(1.1)',
    },
    ':disabled': {
        cursor: 'progress',
    },
});

// 模式未知：中性色，不冒充模擬也不冒充正式
export const unknownBadge = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    color: vars.color.foreground,
    border: `1px dashed ${vars.color.borderBright}`,
    background: vars.color.inset,
    borderRadius: vars.radius.sm,
    padding: '0 10px',
    height: '25px',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
});

export const badgeBroker = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 700,
    padding: '1px 4px',
    borderRadius: '2px',
    border: '1px solid currentColor',
    letterSpacing: 0,
});

export const badgeSep = style({
    opacity: 0.6,
    padding: '0 2px',
});

export const chevron = style({
    marginLeft: '2px',
    opacity: 0.7,
});

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 199,
});

export const popover = style({
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    zIndex: 200,
    width: '19.5rem',
    maxWidth: 'calc(100vw - 16px)',
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
    padding: vars.space.sm,
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

export const section = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
});

export const sectionHeader = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px',
});

export const sectionTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
});

export const routeList = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
});

export const routeRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    fontSize: '0.68rem',
});

export const routeMarket = style({
    fontFamily: vars.font.display,
    fontWeight: 700,
    minWidth: '2.2em',
});

export const routeAccount = style({
    fontFamily: vars.font.mono,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

const envTagBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: '2px',
    border: '1px solid',
    whiteSpace: 'nowrap',
});

export const envTag = {
    sim: style([envTagBase, { color: vars.color.amber, borderColor: vars.color.amber }]),
    // 正式固定 danger 紅（不隨漲跌配色翻轉），與上游 prodBadge 一致
    prod: style([envTagBase, { color: vars.color.danger, borderColor: vars.color.danger, background: vars.color.dangerDim }]),
    unknown: style([envTagBase, { color: vars.color.foreground, borderColor: vars.color.borderBright, borderStyle: 'dashed' }]),
};

export const accountList = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    maxHeight: '140px',
    overflowY: 'auto',
});

const accountItemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 8px',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    background: vars.color.inset,
    color: vars.color.foreground,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'border-color 0.12s, background 0.12s',
    ':disabled': {
        cursor: 'not-allowed',
        opacity: 0.55,
    },
});

export const accountItem = style([
    accountItemBase,
    {
        borderColor: vars.color.border,
        selectors: {
            '&:hover:not(:disabled)': {
                borderColor: vars.color.borderBright,
                background: vars.color.panel,
            },
        },
    },
]);

export const accountItemActive = style([
    accountItemBase,
    {
        borderColor: vars.color.accent,
        background: vars.color.accentDim,
    },
]);

const brokerTagBase = style({
    fontSize: '0.58rem',
    fontWeight: 700,
    padding: '1px 4px',
    borderRadius: '2px',
    border: '1px solid currentColor',
    flexShrink: 0,
});

export const brokerTag = {
    sinopac: style([brokerTagBase, { color: vars.color.accent, background: vars.color.accentDim }]),
    esun: style([brokerTagBase, { color: vars.color.success, background: vars.color.successDim }]),
};

export const accountName = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    flex: 1,
});

export const accountNote = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const linkBtn = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    padding: '5px 8px',
    borderRadius: vars.radius.sm,
    border: `1px dashed ${vars.color.borderBright}`,
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: '0.66rem',
    fontFamily: 'inherit',
    cursor: 'pointer',
    ':hover': {
        borderColor: vars.color.accent,
        color: vars.color.accent,
    },
    ':disabled': {
        cursor: 'progress',
        opacity: 0.6,
    },
});

export const optionGroup = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
});

const optionBase = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    padding: '7px 9px',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    background: vars.color.inset,
    color: vars.color.foreground,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'border-color 0.12s, background 0.12s',
});

export const option = style([
    optionBase,
    {
        borderColor: vars.color.border,
        selectors: {
            '&:hover:not(:disabled)': {
                borderColor: vars.color.borderBright,
                background: vars.color.panel,
            },
        },
    },
]);

// 正式選項：未選取時也以紅框提醒「真實帳戶」
export const optionProd = style([
    optionBase,
    {
        borderColor: vars.color.danger,
        selectors: {
            '&:hover:not(:disabled)': {
                background: vars.color.dangerDim,
            },
        },
    },
]);

export const optionActive = style([
    optionBase,
    {
        borderColor: vars.color.accent,
        background: vars.color.accentDim,
    },
]);

export const optionProdActive = style([
    optionBase,
    {
        borderColor: vars.color.danger,
        background: vars.color.dangerDim,
    },
]);

export const optionDisabled = style([
    optionBase,
    {
        borderColor: vars.color.border,
        color: vars.color.mutedForeground,
        opacity: 0.6,
        cursor: 'not-allowed',
    },
]);

export const optionTop = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px',
});

export const optionLabel = style({
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 600,
});

export const optionSubtitle = style({
    display: 'flex',
    flexDirection: 'column',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.4,
    wordBreak: 'break-all',
});

export const line = style({
    display: 'block',
});

export const checkIcon = style({
    color: vars.color.accent,
    flexShrink: 0,
});

export const configFileBadge = style({
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    fontWeight: 500,
    color: vars.color.accent,
    background: vars.color.accentDim,
    padding: '1px 5px',
    borderRadius: '2px',
    border: `1px solid ${vars.color.accent}`,
    whiteSpace: 'nowrap',
});

export const missingConfigBadge = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    color: vars.color.amber,
    padding: '1px 5px',
    borderRadius: '2px',
    border: `1px solid ${vars.color.amber}`,
    whiteSpace: 'nowrap',
});

export const readonlyRow = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '7px 9px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    fontSize: '0.68rem',
});

export const confirmBox = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 9px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.danger}`,
    background: vars.color.dangerDim,
    color: vars.color.foreground,
    fontSize: '0.68rem',
    lineHeight: 1.45,
});

export const confirmTitle = style({
    fontFamily: vars.font.display,
    fontWeight: 700,
    color: vars.color.danger,
});

export const confirmActions = style({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
});

const actionBtnBase = style({
    padding: '4px 10px',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    fontFamily: 'inherit',
    fontSize: '0.66rem',
    fontWeight: 600,
    cursor: 'pointer',
});

export const cancelBtn = style([
    actionBtnBase,
    {
        borderColor: vars.color.borderBright,
        background: vars.color.panel,
        color: vars.color.foreground,
    },
]);

export const dangerBtn = style([
    actionBtnBase,
    {
        borderColor: vars.color.danger,
        background: vars.color.danger,
        color: '#fff',
    },
]);

export const footerHint = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.45,
    padding: '4px 2px 2px 2px',
    borderTop: `1px dashed ${vars.color.border}`,
});
