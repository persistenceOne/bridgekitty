export interface ChainEntry {
    id: number;
    name: string;
    key: string;
}
export declare function getBackendChainId(backendName: string, chainId: number): number;
export declare function resolveChainId(input: string): number | null;
export declare function getChainName(id: number): string;
export declare function getAllChains(): ChainEntry[];
