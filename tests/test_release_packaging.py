"""Release validation rejects incomplete or inconsistent platform artifacts."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('package_backend', Path(__file__).resolve().parents[1] / 'compilation/package_backend.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class ReleasePackagingTests(unittest.TestCase):
    def archive(self, root, target, version='1.3.4', commit='same-commit', model=True):
        path = root / ('neurotrace-' + target + '.zip')
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('neurotrace.exe' if target == 'windows' else 'neurotrace', b'executable fixture')
            archive.writestr('backend-binary-version.txt', version)
            archive.writestr('THIRD_PARTY_BACKEND_NOTICES.txt', 'notices')
            archive.writestr('build-info.json', json.dumps({'platform': target, 'version': version, 'commit': commit}))
            if model:
                archive.writestr('_internal/onnx_model/model.onnx', b'model fixture')
        return path

    def test_valid_release_has_checksums_for_exactly_three_platforms(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for target in packaging.PLATFORMS:
                self.archive(root, target)
            packaging.verify_release(root, '1.3.4')
            self.assertEqual(len((root / 'SHA256SUMS.txt').read_text().splitlines()), 3)

    def test_mismatched_executable_metadata_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.archive(Path(temp), 'windows', version='1.1.6')
            with self.assertRaisesRegex(ValueError, 'version'):
                packaging.verify_archive(path, '1.3.4', 'windows')

    def test_missing_model_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.archive(Path(temp), 'linux', model=False)
            with self.assertRaisesRegex(ValueError, 'model'):
                packaging.verify_archive(path, '1.3.4', 'linux')

    def test_platforms_from_different_commits_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for target in packaging.PLATFORMS:
                self.archive(root, target, commit=target)
            with self.assertRaisesRegex(ValueError, 'commit'):
                packaging.verify_release(root, '1.3.4')
