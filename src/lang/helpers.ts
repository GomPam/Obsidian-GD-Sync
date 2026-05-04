import { moment } from "obsidian";
import en from "./en";
import ko from "./ko";

const localeMap: { [k: string]: Partial<typeof en> } = {
    en,
    ko,
};

const locale = localeMap[moment.locale()] || en;

/**
 * Retrieves the translated string for the given key.
 * Supports string variable substitution like `{name}` or `{path}`.
 * 
 * Example: t('NOTICE_UPLOAD_COMPLETE', { name: "test.md" })
 */
export function t(key: keyof typeof en, variables?: Record<string, string | number>): string {
    let str = (locale && locale[key]) || en[key] || key;
    
    if (variables) {
        for (const [varName, varValue] of Object.entries(variables)) {
            str = str.replace(new RegExp(`{${varName}}`, 'g'), String(varValue));
        }
    }
    
    return str;
}
