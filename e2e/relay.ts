/**
 * Relay instructions utilities for Wormhole Executor
 */

/**
 * Create relay instructions for the Executor quote request
 *
 * Format: 0x01 (version byte) + uint128 gasLimit (16 bytes) + uint128 msgValue (16 bytes)
 * 
 * For Solana destinations:
 * - gasLimit = compute units (e.g., 500_000)
 * - msgValue = lamports for rent/priority fees (e.g., 15_000_000 = 0.015 SOL)
 */
export function createRelayInstructions(gasLimit: bigint, msgValue: bigint): string {
    const version = '01';
    const gasLimitHex = gasLimit.toString(16).padStart(32, '0');
    const msgValueHex = msgValue.toString(16).padStart(32, '0');
    return '0x' + version + gasLimitHex + msgValueHex;
}
