"""
NeuroTrace Encryption Methods - Open Source for Security Auditing

This module contains all encryption-related functionality used by NeuroTrace.
Made publicly available for security auditing and transparency.

NeuroTrace uses SQLCipher (https://www.zetetic.net/sqlcipher/) for database
encryption, providing AES-256 encryption at rest.

Security through strong passphrases, not obscurity.

© 2025 BlackIron Technologies Ltd.
Licensed under: MIT License (for this file only)
"""

import sqlite3
import shutil
import os
from pathlib import Path
from typing import Optional, Dict, Any

try:
    from sqlcipher3 import dbapi2 as sqlite_cipher
except ImportError:
    sqlite_cipher = None


def apply_sqlcipher_key(connection, password: str) -> None:
    """
    Apply SQLCipher encryption key to a database connection.

    Uses parameter binding for security when possible, falls back to
    sanitized string interpolation if needed for compatibility.

    Args:
        connection: SQLCipher database connection
        password: Encryption passphrase

    Raises:
        ValueError: If password is None
        Exception: If key application fails

    Security Note:
        - The passphrase never leaves your machine
        - AES-256 encryption is applied using SQLCipher
        - Key derivation uses PBKDF2 with 256,000 iterations (SQLCipher default)
    """
    if password is None:
        raise ValueError("Password cannot be None")

    try:
        # Preferred method: parameter binding
        connection.execute("PRAGMA key = ?", (password,))
    except Exception as primary_error:
        # Fallback: sanitize and use string interpolation
        sanitized = password.replace("'", "''")
        try:
            connection.execute(f"PRAGMA key = '{sanitized}'")
        except Exception:
            raise primary_error


def check_database_status(db_path: str) -> Dict[str, str]:
    """
    Check if a database file is encrypted, unencrypted, or doesn't exist.

    Args:
        db_path: Path to the SQLite database file

    Returns:
        Dict with 'status' key:
        - 'NO_DB': Database file doesn't exist
        - 'UNENCRYPTED': Database exists and is not encrypted
        - 'LOCKED': Database exists and is encrypted (needs passphrase)

    Example:
        >>> status = check_database_status('/path/to/db.db')
        >>> print(status['status'])
        'LOCKED'
    """
    if not os.path.exists(db_path):
        return {"status": "NO_DB"}

    try:
        # Try to open as unencrypted database
        conn = sqlite3.connect(db_path)
        conn.execute("SELECT count(*) FROM sqlite_master;")
        conn.close()
        return {"status": "UNENCRYPTED"}
    except Exception:
        # If it fails, it's likely encrypted
        return {"status": "LOCKED"}


def unlock_encrypted_database(db_path: str, password: str) -> Dict[str, Any]:
    """
    Unlock an encrypted database and verify the passphrase is correct.

    Args:
        db_path: Path to the encrypted SQLite database
        password: Decryption passphrase

    Returns:
        Dict with:
        - 'status': 'ok' on success, 'error' on failure
        - 'message': Error message if failed
        - 'connection': Database connection object if successful

    Security Note:
        - This only verifies the passphrase and returns a connection
        - The connection must be managed by the caller
        - The passphrase is never logged or stored

    Example:
        >>> result = unlock_encrypted_database('/path/to/db.db', 'my_passphrase')
        >>> if result['status'] == 'ok':
        ...     conn = result['connection']
    """
    if not sqlite_cipher:
        return {
            "status": "error",
            "message": "sqlcipher3 not installed. Install with: pip install sqlcipher3",
        }

    try:
        conn = sqlite_cipher.connect(db_path)
        apply_sqlcipher_key(conn, password)

        # Verify the passphrase by attempting to read
        conn.execute("SELECT count(*) FROM sqlite_master;")

        return {"status": "ok", "connection": conn}
    except Exception as e:
        return {
            "status": "error",
            "message": "Invalid passphrase or corrupted database.",
        }


def encrypt_database(
    source_db_path: str, password: str, temp_path: Optional[str] = None
) -> Dict[str, str]:
    """
    Migrate an unencrypted SQLite database to an encrypted one.

    This function:
    1. Reads the unencrypted source database
    2. Creates a new encrypted database with the same schema and data
    3. Replaces the original with the encrypted version

    Args:
        source_db_path: Path to the unencrypted database
        password: Encryption passphrase (recommend 12+ characters)
        temp_path: Optional custom path for temporary encrypted file

    Returns:
        Dict with 'status' ('ok' or 'error') and optional 'message'

    Security Notes:
        - Original unencrypted file is deleted after successful encryption
        - Temporary file is created during migration
        - Uses SQLCipher's native AES-256 encryption
        - PBKDF2 key derivation with 256,000 iterations

    Warning:
        - This operation is irreversible without the passphrase
        - Make a backup before encrypting if needed

    Example:
        >>> result = encrypt_database('/path/to/data.db', 'strong_passphrase')
        >>> if result['status'] == 'ok':
        ...     print("Database encrypted successfully")
    """
    if not sqlite_cipher:
        return {
            "status": "error",
            "message": "sqlcipher3 is not available. Install with: pip install sqlcipher3",
        }

    if not os.path.exists(source_db_path):
        return {"status": "error", "message": "Source database not found."}

    # Generate temp path if not provided
    if temp_path is None:
        db_dir = os.path.dirname(source_db_path)
        temp_path = os.path.join(db_dir, "temp_encrypted.db")

    try:
        # Open source (unencrypted) database
        source_conn = sqlite3.connect(source_db_path)
        source_conn.row_factory = sqlite3.Row

        # Create encrypted database
        encrypted_conn = sqlite_cipher.connect(temp_path)
        apply_sqlcipher_key(encrypted_conn, password)

        # Copy schema
        cursor = source_conn.cursor()
        cursor.execute("SELECT sql FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()

        encrypted_cursor = encrypted_conn.cursor()
        for table in tables:
            if table[0] and "sqlite_sequence" not in table[0]:
                encrypted_cursor.execute(table[0])

        # Copy data
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        table_names = cursor.fetchall()

        for table_name in table_names:
            name = table_name[0]
            if not name.startswith("sqlite_"):
                cursor.execute(f"SELECT * FROM {name}")
                rows = cursor.fetchall()

                if rows:
                    columns = [description[0] for description in cursor.description]
                    placeholders = ", ".join(["?"] * len(columns))
                    column_str = ", ".join(columns)

                    for row in rows:
                        row_data = [row[column] for column in range(len(columns))]
                        encrypted_cursor.execute(
                            f"INSERT INTO {name} ({column_str}) VALUES ({placeholders})",
                            row_data,
                        )

        # Commit and close
        encrypted_conn.commit()
        source_conn.close()
        encrypted_conn.close()

        # Replace original with encrypted version
        shutil.move(temp_path, source_db_path)

        return {"status": "ok"}

    except Exception as e:
        # Clean up temp file on error
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except:
                pass

        return {"status": "error", "message": f"Encryption failed: {str(e)}"}


def decrypt_database(
    encrypted_db_path: str, password: str, temp_path: Optional[str] = None
) -> Dict[str, str]:
    """
    Migrate an encrypted SQLite database to an unencrypted one.

    This function:
    1. Reads the encrypted source database
    2. Creates a new unencrypted database with the same schema and data
    3. Replaces the original with the unencrypted version

    Args:
        encrypted_db_path: Path to the encrypted database
        password: Decryption passphrase
        temp_path: Optional custom path for temporary unencrypted file

    Returns:
        Dict with 'status' ('ok' or 'error') and optional 'message'

    Security Warning:
        - This removes encryption from your database
        - Your data will no longer be protected at rest
        - Only use this if you understand the security implications

    Example:
        >>> result = decrypt_database('/path/to/data.db', 'passphrase')
        >>> if result['status'] == 'ok':
        ...     print("Database decrypted (now unprotected)")
    """
    if not sqlite_cipher:
        return {
            "status": "error",
            "message": "sqlcipher3 is not available. Install with: pip install sqlcipher3",
        }

    if not os.path.exists(encrypted_db_path):
        return {"status": "error", "message": "Encrypted database not found."}

    # Generate temp path if not provided
    if temp_path is None:
        db_dir = os.path.dirname(encrypted_db_path)
        temp_path = os.path.join(db_dir, "temp_decrypted.db")

    try:
        # Verify passphrase first
        test_conn = sqlite_cipher.connect(encrypted_db_path)
        apply_sqlcipher_key(test_conn, password)
        test_conn.execute("SELECT count(*) FROM sqlite_master")
        test_conn.close()

        # Open encrypted database
        encrypted_conn = sqlite_cipher.connect(encrypted_db_path)
        apply_sqlcipher_key(encrypted_conn, password)

        # Create unencrypted database
        decrypted_conn = sqlite3.connect(temp_path)

        # Copy schema
        cursor = encrypted_conn.cursor()
        cursor.execute("SELECT sql FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()

        decrypted_cursor = decrypted_conn.cursor()
        for table in tables:
            if table[0] and "sqlite_sequence" not in table[0]:
                decrypted_cursor.execute(table[0])

        # Copy data
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        table_names = cursor.fetchall()

        for table_name in table_names:
            name = table_name[0]
            if not name.startswith("sqlite_"):
                cursor.execute(f"SELECT * FROM {name}")
                rows = cursor.fetchall()

                if rows:
                    columns = [description[0] for description in cursor.description]
                    placeholders = ", ".join(["?"] * len(columns))
                    column_str = ", ".join(columns)

                    for row in rows:
                        row_data = [row[column] for column in range(len(columns))]
                        decrypted_cursor.execute(
                            f"INSERT INTO {name} ({column_str}) VALUES ({placeholders})",
                            row_data,
                        )

        # Commit and close
        decrypted_conn.commit()
        encrypted_conn.close()
        decrypted_conn.close()

        # Replace original with decrypted version
        shutil.move(temp_path, encrypted_db_path)

        return {"status": "ok"}

    except Exception as e:
        # Clean up temp file on error
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except:
                pass

        return {"status": "error", "message": f"Decryption failed: {str(e)}"}


# Example usage and testing
if __name__ == "__main__":
    print("NeuroTrace Encryption Methods - Security Audit Module")
    print("=" * 60)
    print("\nThis module is open source for security auditing.")
    print("All encryption uses SQLCipher with AES-256.")
    print("\nKey points:")
    print("  • Passphrases never leave your machine")
    print("  • PBKDF2 key derivation (256,000 iterations)")
    print("  • Industry-standard encryption algorithms")
    print("  • No backdoors, no proprietary crypto")
    print("\nFor full documentation, see:")
    print("  https://www.zetetic.net/sqlcipher/sqlcipher-api/")
    print("\n" + "=" * 60)
