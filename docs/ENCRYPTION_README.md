# NeuroTrace Encryption Module - Security Audit Documentation

## Overview

This module (`encryption_methods.py`) contains **all encryption-related functionality** used by NeuroTrace. It is **fully open source** under the MIT License to enable security auditing and build trust with privacy-conscious users.

## Why Open Source?

Following [Kerckhoffs's principle](https://en.wikipedia.org/wiki/Kerckhoffs%27s_principle), we believe:

> "A cryptosystem should be secure even if everything about the system, except the key, is public knowledge."

**Security through strong passphrases, not obscurity.**

## Encryption Technology

### SQLCipher (AES-256)
- **Library**: [SQLCipher](https://www.zetetic.net/sqlcipher/)
- **Algorithm**: AES-256-CBC
- **Key Derivation**: PBKDF2-HMAC-SHA512
- **Iterations**: 256,000 (SQLCipher default)
- **Salt**: Randomly generated per database

### What This Means
- Industry-standard encryption used by Signal, WhatsApp, and others
- Even with access to the database file, data is unreadable without the passphrase
- No master keys, no backdoors, no recovery mechanism (by design)

## Public Functions

### `apply_sqlcipher_key(connection, password)`
Applies encryption key to a SQLCipher connection.
- **Security**: Uses parameter binding to prevent SQL injection
- **Fallback**: Sanitized string interpolation for compatibility

### `check_database_status(db_path)`
Determines if a database is encrypted, unencrypted, or missing.
- **Returns**: `{'status': 'NO_DB' | 'UNENCRYPTED' | 'LOCKED'}`

### `unlock_encrypted_database(db_path, password)`
Unlocks an encrypted database and verifies the passphrase.
- **Returns**: Connection object on success
- **Security**: Passphrase never logged or stored

### `encrypt_database(source_db_path, password, temp_path=None)`
Migrates an unencrypted database to encrypted format.
- **Process**: Schema + data copied to new encrypted file
- **Atomic**: Original replaced only after successful encryption
- **Warning**: Irreversible without passphrase

### `decrypt_database(encrypted_db_path, password, temp_path=None)`
Migrates an encrypted database to unencrypted format.
- **Security Warning**: Removes protection - use only if necessary
- **Process**: Schema + data copied to new unencrypted file

## Security Best Practices

### Strong Passphrases
- **Minimum**: 12+ characters
- **Recommended**: 16+ characters with mixed case, numbers, symbols
- **Avoid**: Dictionary words, personal information, reused passwords

### Key Management
- **Never hardcode** passphrases in your code
- **Don't share** passphrases via email, chat, or insecure channels
- **Use password managers** to generate and store strong passphrases
- **No recovery mechanism**: Lost passphrase = lost data (by design)

### Database Security
- Encrypted databases still need OS-level permissions protection
- Temporary files are created during migration (briefly unprotected)
- Keep your system and dependencies updated

## Security Audit Checklist

✅ **No custom cryptography** - Uses battle-tested SQLCipher  
✅ **No key escrow** - Only user knows the passphrase  
✅ **No telemetry of passphrases** - Never transmitted or logged  
✅ **Parameter binding** - SQL injection protection  
✅ **Error handling** - Fails secure (locks on errors)  
✅ **Atomic operations** - Original file replaced only on success  
✅ **Open source** - Full code available for audit  


## Questions & Support

**General questions about encryption:**
- [Create a GitHub issue](https://github.com/BlackIron-Technologies/Neurotrace_c/issues/new?title=Encryption%20Question&labels=encryption,question)

**Security vulnerabilities:** contact@blackironhq.com (private disclosure only)


## Dependencies

```bash
pip install sqlcipher3
```

**Version requirements:**
- Python 3.8+
- sqlcipher3 >= 0.5.0
- SQLCipher library >= 4.5.0

## Testing Encryption

```python
from encryption_methods import *

# Test encryption cycle
db_path = "test.db"

# Check status
status = check_database_status(db_path)
print(f"Database status: {status['status']}")

# Encrypt
result = encrypt_database(db_path, "strong_passphrase_123")
if result['status'] == 'ok':
    print("✓ Database encrypted")

# Verify it's locked
status = check_database_status(db_path)
assert status['status'] == 'LOCKED'

# Unlock
unlock_result = unlock_encrypted_database(db_path, "strong_passphrase_123")
if unlock_result['status'] == 'ok':
    print("✓ Database unlocked with correct passphrase")
    
# Test wrong passphrase
wrong_result = unlock_encrypted_database(db_path, "wrong_pass")
assert wrong_result['status'] == 'error'
print("✓ Wrong passphrase correctly rejected")
```

## License

This file (`encryption_methods.py`) is licensed under the **MIT License**:

```
MIT License

Copyright (c) 2025 BlackIron Technologies Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Note**: This MIT license applies **only** to `encryption_methods.py`. The rest of NeuroTrace remains under proprietary license (see main [LICENSE.md](../LICENSE.md)).

## Further Reading

- [SQLCipher Documentation](https://www.zetetic.net/sqlcipher/documentation/)
- [SQLCipher API](https://www.zetetic.net/sqlcipher/sqlcipher-api/)
- [SQLCipher Design](https://www.zetetic.net/sqlcipher/design/)
- [Kerckhoffs's Principle](https://en.wikipedia.org/wiki/Kerckhoffs%27s_principle)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)


© 2025 BlackIron Technologies Ltd.
