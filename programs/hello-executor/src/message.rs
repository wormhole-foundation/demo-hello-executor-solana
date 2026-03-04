use anchor_lang::{AnchorDeserialize, AnchorSerialize};
use std::io;
use wormhole_io::Readable;

/// Payload ID for Alive message (sent during initialization)
const PAYLOAD_ID_ALIVE: u8 = 0;

/// Payload ID for Hello/Greeting message.
///
/// **Why this prefix exists:**
/// Solana-to-Solana (and Solana-to-any-structured-receiver) messages use a tagged
/// format — `0x01 | u16_be_len | message_bytes` — so receivers can distinguish
/// Alive (init) from Hello (greeting) payloads without ambiguity.
///
/// **EVM side strips this prefix.**
/// `HelloWormhole.sol#_executeVaa` detects `peerChain == CHAIN_ID_SOLANA` and
/// strips the 3-byte header before emitting `GreetingReceived`, so the event
/// contains the clean message string.
const PAYLOAD_ID_HELLO: u8 = 1;

/// Maximum length of a greeting message in bytes
pub const GREETING_MAX_LENGTH: usize = 512;

/// Message types for the Hello Executor program.
///
/// * `Alive` - Payload ID 0: Emitted when [`initialize`](crate::initialize) is called.
/// * `Hello` - Payload ID 1: Emitted when [`send_greeting`](crate::send_greeting) is called.
#[derive(Clone, Debug)]
pub enum HelloExecutorMessage {
    /// Initialization message containing the program ID
    Alive {
        /// The program ID that initialized the emitter
        program_id: [u8; 32],
    },
    /// Greeting message containing the user's message
    Hello {
        /// The greeting message bytes (UTF-8 encoded string)
        message: Vec<u8>,
    },
}

impl AnchorSerialize for HelloExecutorMessage {
    fn serialize<W: io::Write>(&self, writer: &mut W) -> io::Result<()> {
        match self {
            HelloExecutorMessage::Alive { program_id } => {
                PAYLOAD_ID_ALIVE.serialize(writer)?;
                writer.write_all(program_id)
            }
            HelloExecutorMessage::Hello { message } => {
                if message.len() > GREETING_MAX_LENGTH {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("message exceeds {GREETING_MAX_LENGTH} bytes"),
                    ));
                }
                PAYLOAD_ID_HELLO.serialize(writer)?;
                // Encode length as big-endian u16 (compatible with EVM)
                (message.len() as u16).to_be_bytes().serialize(writer)?;
                writer.write_all(message)
            }
        }
    }
}

impl AnchorDeserialize for HelloExecutorMessage {
    fn deserialize_reader<R: io::Read>(reader: &mut R) -> io::Result<Self> {
        match u8::read(reader)? {
            PAYLOAD_ID_ALIVE => {
                let mut program_id = [0u8; 32];
                reader.read_exact(&mut program_id)?;
                Ok(HelloExecutorMessage::Alive { program_id })
            }
            PAYLOAD_ID_HELLO => {
                let length = u16::read(reader)? as usize;
                if length > GREETING_MAX_LENGTH {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("message exceeds {GREETING_MAX_LENGTH} bytes"),
                    ));
                }
                let mut message = vec![0u8; length];
                reader.read_exact(&mut message)?;
                Ok(HelloExecutorMessage::Hello { message })
            }
            id => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid payload ID: {id}"),
            )),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_message_alive() {
        let program_id = [1u8; 32];
        let msg = HelloExecutorMessage::Alive { program_id };

        let mut encoded = Vec::new();
        msg.serialize(&mut encoded).unwrap();

        assert_eq!(encoded.len(), 1 + 32); // payload ID + program ID
        assert_eq!(encoded[0], PAYLOAD_ID_ALIVE);

        let decoded = HelloExecutorMessage::deserialize(&mut encoded.as_slice()).unwrap();
        match decoded {
            HelloExecutorMessage::Alive { program_id: decoded_id } => {
                assert_eq!(decoded_id, program_id);
            }
            _ => panic!("wrong message type"),
        }
    }

    #[test]
    fn test_message_hello() {
        let message = b"Hello, World!".to_vec();
        let msg = HelloExecutorMessage::Hello { message: message.clone() };

        let mut encoded = Vec::new();
        msg.serialize(&mut encoded).unwrap();

        assert_eq!(encoded.len(), 1 + 2 + message.len()); // payload ID + length + message
        assert_eq!(encoded[0], PAYLOAD_ID_HELLO);
        assert_eq!(u16::from_be_bytes([encoded[1], encoded[2]]) as usize, message.len());

        let decoded = HelloExecutorMessage::deserialize(&mut encoded.as_slice()).unwrap();
        match decoded {
            HelloExecutorMessage::Hello { message: decoded_msg } => {
                assert_eq!(decoded_msg, message);
            }
            _ => panic!("wrong message type"),
        }
    }

    #[test]
    fn test_message_too_large() {
        let message = vec![0u8; GREETING_MAX_LENGTH + 1];
        let msg = HelloExecutorMessage::Hello { message };

        let mut encoded = Vec::new();
        let result = msg.serialize(&mut encoded);
        assert!(result.is_err());
    }
}
