export interface ChainEntry {
    id: number;
    name: string;
    key: string;
}
export declare function resolveChainId(input: string): number | null;
export declare function getChainName(id: number): string;
export declare function getAllChains(): ChainEntry[];
