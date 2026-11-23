"""Validate legacy rows and explicit import transformations before sharing."""
import json
from pathlib import Path, PurePosixPath

from .domain import FIELDS, TYPES, validate_fields
from .store import SyncError


class ImportValidationError(ValueError):
    def __init__(self, report):
        self.report = report
        super().__init__('Legacy import needs review: ' + json.dumps(report, ensure_ascii=True))


def remap_path(workspace, value):
    parts = PurePosixPath(value.replace('\\', '/')).parts
    if '..' in parts:
        return None
    for index in range(len(parts)):
        try:
            candidate = workspace.joinpath(*parts[index:]).resolve()
            relative = candidate.relative_to(workspace)
        except (ValueError, OSError):
            continue
        if candidate.is_file():
            return relative.as_posix()
    return None


def prepare_import(workspace, rows, path_policy='reject', type_map=None):
    if path_policy not in ('reject', 'remap', 'detach'):
        raise ValueError('Choose reject, remap or detach for legacy code references')
    type_map = {} if type_map is None else type_map
    if not isinstance(type_map, dict) or any(not isinstance(k, str) or not isinstance(v, str) or v not in TYPES for k, v in type_map.items()):
        raise ValueError('Map legacy types explicitly to supported memory types')
    workspace = Path(workspace).resolve()
    prepared, issues, changes = [], [], []
    for row in rows:
        fields = {key: row.get(key) for key in FIELDS}
        text = row.get('text')
        path = fields.get('file_path')
        if isinstance(path, str) and path:
            try:
                candidate = Path(path)
                candidate = (candidate if candidate.is_absolute() else workspace / candidate).resolve()
                if ':' in path.replace('\\', '/') and not Path(path).is_absolute():
                    raise ValueError('Foreign absolute path')
                fields['file_path'] = candidate.relative_to(workspace).as_posix()
            except (ValueError, OSError):
                mapped = remap_path(workspace, path)
                if path_policy == 'remap' and mapped:
                    fields['file_path'] = mapped
                    changes.append({'id': row['id'], 'field': 'file_path', 'from': path, 'to': mapped})
                elif path_policy == 'detach':
                    fields['file_path'], fields['line'], fields['snippet'] = None, None, None
                    text = ((text or '') + '\n\n[Original code reference: ' + path +
                            (':' + str(row['line']) if row.get('line') else '') + ']')
                    if row.get('snippet'):
                        text += '\n' + row['snippet']
                    changes.append({'id': row['id'], 'field': 'file_path', 'from': path, 'to': None})
                else:
                    issues.append({'id': row['id'], 'field': 'file_path', 'value': path,
                                   'error': 'Code reference is outside this workspace', 'suggested_path': mapped})
                    fields['file_path'] = None
        if fields['type'] in type_map:
            original = fields['type']
            fields['type'] = type_map[original]
            changes.append({'id': row['id'], 'field': 'type', 'from': original, 'to': fields['type']})
        for key, value in fields.items():
            try:
                validate_fields({key: value})
            except SyncError as exc:
                issues.append({'id': row['id'], 'field': key, 'value': value, 'error': str(exc)})
        if not isinstance(text, str) or not 1 <= len(text) <= 100000:
            issues.append({'id': row['id'], 'field': 'text', 'error': 'Text must contain 1 to 100000 characters'})
        prepared.append({**row, **fields, 'text': text})
    return prepared, {'valid': not issues, 'memory_count': len(rows), 'issues': issues, 'transformations': changes,
                      'path_policy': path_policy, 'type_map': type_map}


def preview_import(conn, workspace, path_policy='reject', type_map=None):
    rows = [dict(row) for row in conn.execute('SELECT * FROM thoughts')] if conn else []
    return prepare_import(workspace, rows, path_policy, type_map)[1]
