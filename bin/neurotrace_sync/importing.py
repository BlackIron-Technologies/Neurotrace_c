"""Explicit, transactional reconciliation of pre-existing local memories."""
import json
import time
import uuid

from .domain import FIELDS


def import_existing(replica, snapshot, local, relations, path_policy='reject', type_map=None):
    from .import_validation import prepare_import, ImportValidationError
    originals = local
    local, validation = prepare_import(replica.workspace, local, path_policy, type_map)
    if not validation['valid']:
        raise ImportValidationError(validation)
    remote = {row['id']: row for row in snapshot['records']}
    mapping, creates, collisions, reused = {}, [], [], []
    for row in local:
        fields = replica.fields_to_wire({key: row.get(key) for key in FIELDS})
        other = remote.get(row['id'])
        same = bool(other and not other['deleted'] and other['kind'] == 'thought' and
                    other['data'].get('text') == row['text'] and all(other['data'].get(key) == fields.get(key) for key in FIELDS))
        if same:
            mapping[row['id']] = row['id']
            reused.append(row['id'])
            continue
        record_id = str(uuid.uuid4()) if other else row['id']
        mapping[row['id']] = record_id
        if other:
            collisions.append({'original_id': row['id'], 'preserved_local_id': record_id})
        creates.append((record_id, fields, row['text']))
    backup_id = str(uuid.uuid4())
    report = {'imported_memories': len(creates), 'reused_memories': len(reused), 'preserved_versions': collisions,
              'validation': validation, 'imported_relations': 0, 'skipped_relations': [], 'backup_id': backup_id,
              'backup_location': 'sync_import_backups in this local database; same encryption as the database'}
    # Keep the original logical data inside the same database, including SQLCipher protection.
    with replica.conn:
        replica.conn.execute('CREATE TABLE IF NOT EXISTS sync_import_backups(id TEXT PRIMARY KEY,at REAL,thoughts TEXT,relations TEXT,report TEXT)')
        replica.conn.execute('INSERT INTO sync_import_backups VALUES(?,?,?,?,?)',
                             (backup_id, time.time(), json.dumps([{k: v for k, v in row.items() if k != 'embedding'} for row in originals]), json.dumps(relations), json.dumps(report)))
        replica.conn.execute('DELETE FROM relations')
        replica.conn.execute('DELETE FROM thoughts')
        for record in sorted(snapshot['records'], key=lambda value: value['kind'] == 'relation'):
            replica.apply_record(record, snapshot['cursor'])
        for record_id, fields, text in creates:
            # fields are already relative; _enqueue performs the same validated normalization.
            replica._enqueue(record_id, 'create', fields, text)
        for row in relations:
            fields = {key: row.get(key) for key in ('src', 'dst', 'rel', 'meta')}
            fields['src'], fields['dst'] = mapping.get(fields['src'], fields['src']), mapping.get(fields['dst'], fields['dst'])
            if not all(replica.conn.execute('SELECT 1 FROM thoughts WHERE id=?', (fields[key],)).fetchone() for key in ('src', 'dst')):
                report['skipped_relations'].append(row['id'])
                continue
            other = remote.get(row['id'])
            if other and not other['deleted'] and other['kind'] == 'relation' and other['data'] == fields:
                continue
            replica._enqueue(str(uuid.uuid4()) if other else row['id'], 'relation', fields)
            report['imported_relations'] += 1
        replica.conn.execute('UPDATE sync_binding SET cursor=? WHERE project=?', (snapshot['cursor'], replica.project))
        replica.conn.execute('UPDATE sync_import_backups SET report=? WHERE id=?', (json.dumps(report), backup_id))
    return report
