use anchor_lang::prelude::error_code;

#[error_code]
/// Errors for the Hello Executor program.
pub enum HelloExecutorError {
    #[msg("InvalidWormholeConfig")]
    /// Specified Wormhole bridge data PDA is wrong.
    InvalidWormholeConfig,

    #[msg("InvalidWormholeFeeCollector")]
    /// Specified Wormhole fee collector PDA is wrong.
    InvalidWormholeFeeCollector,

    #[msg("InvalidWormholeSequence")]
    /// Specified emitter's sequence PDA is wrong.
    InvalidWormholeSequence,

    #[msg("OwnerOnly")]
    /// Only the program's owner is permitted.
    OwnerOnly,

    #[msg("InvalidPeer")]
    /// Specified peer has a bad chain ID or zero address.
    InvalidPeer,

    #[msg("UnknownEmitter")]
    /// The emitter of the VAA is not a registered peer.
    UnknownEmitter,

    #[msg("InvalidMessage")]
    /// Deserialized message has unexpected payload type.
    InvalidMessage,

    #[msg("MessageTooLarge")]
    /// Message exceeds maximum allowed length.
    MessageTooLarge,

    #[msg("InvalidVaa")]
    /// VAA verification failed.
    InvalidVaa,

    #[msg("AlreadyReceived")]
    /// This message has already been received (replay protection).
    AlreadyReceived,

    #[msg("NoMessagesYet")]
    /// No Wormhole messages have been posted yet.
    NoMessagesYet,
}
