export declare function getHarnessAdminUrl(): string;
export declare function getHarnessAdminUrlWithSource(): {
    url: string;
    source: string;
};
/** Test-only — clears the in-process cache between tests. */
export declare function _resetHarnessAdminUrlCacheForTests(): void;
