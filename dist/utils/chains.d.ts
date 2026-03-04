export interface ChainEntry {
    id: number;
    name: string;
    key: string;
}
export declare const PERSISTENCE_CHAIN_ID = 9999001;
export declare const COSMOSHUB_CHAIN_ID = 9999002;
export declare function getBackendChainId(backendName: string, chainId: number): number;
export declare const COSMOS_CHAIN_IDS: Record<string, string>;
export declare const SYNTHETIC_TO_COSMOS: Record<number, string>;
export declare function resolveChainId(input: string): number | null;
/** Check if a chain key or ID refers to a Cosmos chain */
export declare function isCosmosChain(chainKeyOrId: string | number): boolean;
/** Get the Cosmos chain ID string for Squid Router from a synthetic numeric ID */
export declare function getCosmosChainIdFromSynthetic(syntheticId: number): string | null;
/** Get the Cosmos chain ID string from a chain key */
export declare function getCosmosChainId(key: string): string | null;
export declare function getChainName(id: number): string;
export declare function getAllChains(): ChainEntry[];
