"""Legacy import preflight preserves originals and reports every problem."""
import json
from pathlib import Path
import tempfile
import unittest

from test_sync import local_replica
from neurotrace_sync.import_validation import prepare_import, ImportValidationError


class LegacyValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'src').mkdir()
        (self.root / 'src/file.ts').write_text('code', encoding='utf-8')
        self.row = {'id': 'old', 'text': 'Original', 'type': 'finding', 'file_path': '/Users/other/repository/src/file.ts',
                    'line': 3, 'snippet': 'some code'}

    def tearDown(self):
        self.temp.cleanup()

    def test_all_rows_and_fields_reported_without_mutation(self):
        rows = [self.row, {**self.row, 'id': 'second', 'priority': 'urgent', 'text': ''}]
        _, report = prepare_import(self.root, rows)
        self.assertFalse(report['valid'])
        self.assertEqual(len(report['issues']), 6)
        self.assertEqual(self.row['type'], 'finding')
        self.assertEqual(report['issues'][0]['suggested_path'], 'src/file.ts')

    def test_explicit_remap_and_type_map_preserve_original_backup(self):
        replica = local_replica(self.root / 'local.db', 'project')
        try:
            replica.conn.execute('INSERT INTO thoughts(id,text,type,file_path,line,snippet) VALUES(:id,:text,:type,:file_path,:line,:snippet)', self.row)
            replica.conn.commit()
            snapshot = {'records': [], 'role': 'owner', 'cursor': 0}
            with self.assertRaises(ImportValidationError):
                replica.initialize(snapshot, publish=True)
            self.assertEqual(replica.conn.execute('SELECT COUNT(*) FROM sync_outbox').fetchone()[0], 0)
            self.assertEqual(replica.conn.execute('SELECT type FROM thoughts').fetchone()[0], 'finding')
            result = replica.initialize(snapshot, publish=True, path_policy='remap', type_map={'finding': 'insight'})
            saved = dict(replica.conn.execute('SELECT * FROM thoughts').fetchone())
            self.assertEqual(saved['type'], 'insight')
            self.assertEqual(Path(saved['file_path']), (self.root / 'src/file.ts').resolve())
            backup = json.loads(replica.conn.execute('SELECT thoughts FROM sync_import_backups WHERE id=?', (result['backup_id'],)).fetchone()[0])
            self.assertEqual(backup[0]['file_path'], self.row['file_path'])
            self.assertEqual(backup[0]['type'], 'finding')
        finally:
            replica.conn.close()

    def test_detach_preserves_path_line_and_snippet_in_text(self):
        rows, report = prepare_import(self.root, [self.row], 'detach', {'finding': 'insight'})
        self.assertTrue(report['valid'])
        self.assertIsNone(rows[0]['file_path'])
        self.assertIn(self.row['file_path'] + ':3', rows[0]['text'])
        self.assertIn(self.row['snippet'], rows[0]['text'])

    def test_missing_and_traversal_paths_cannot_be_remapped(self):
        for path in ['/other/absent.py', '/other/../src/file.ts', r'C:\other\absent.py']:
            _, report = prepare_import(self.root, [{**self.row, 'file_path': path}], 'remap', {'finding': 'insight'})
            self.assertFalse(report['valid'], path)
