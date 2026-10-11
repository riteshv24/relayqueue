"""Release gates must reject unsafe selections before publication."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_guard', Path(__file__).with_name('validate_release.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ReleaseGateTests(unittest.TestCase):
    def invoke(self, *, ref='refs/heads/main', version='v1.2.3', prs=None, existing=False):
        merged = {'merged_at': '2026-10-11T00:00:00Z', 'base': {'ref': 'main'}, 'merge_commit_sha': 'a' * 40}
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'output'
            values = {'GITHUB_REF': ref, 'RELEASE_VERSION': version, 'GITHUB_SHA': 'a' * 40,
                      'GITHUB_OUTPUT': str(output)}
            responses = [[merged] if prs is None else prs, {'ref': 'existing'} if existing else None]
            with patch.dict(os.environ, values), patch.object(guard, 'api', side_effect=responses), contextlib.redirect_stdout(io.StringIO()):
                guard.main()
            return output.read_text()

    def test_feature_branch_cannot_release(self):
        with self.assertRaisesRegex(SystemExit, 'main'):
            self.invoke(ref='refs/heads/feature')

    def test_unmerged_commit_cannot_release(self):
        with self.assertRaisesRegex(SystemExit, 'merged pull request'):
            self.invoke(prs=[])

    def test_open_pr_is_not_a_merge(self):
        with self.assertRaisesRegex(SystemExit, 'merged pull request'):
            self.invoke(prs=[{'merged_at': None, 'base': {'ref': 'main'}, 'merge_commit_sha': 'a' * 40}])

    def test_other_commit_or_target_is_not_accepted(self):
        for base, sha in [('main', 'b' * 40), ('develop', 'a' * 40)]:
            with self.subTest(base=base, sha=sha), self.assertRaises(SystemExit):
                self.invoke(prs=[{'merged_at': 'now', 'base': {'ref': base}, 'merge_commit_sha': sha}])

    def test_existing_version_is_not_overwritten(self):
        with self.assertRaisesRegex(SystemExit, 'already exists'):
            self.invoke(existing=True)

    def test_invalid_or_injected_version_is_rejected(self):
        for version in ['latest', 'v01.2.3', 'v1.2.3\nother=value', 'v1.2.3;echo unsafe', '../main']:
            with self.subTest(version=version), self.assertRaises(SystemExit):
                self.invoke(version=version)

    def test_exact_merged_commit_accepts_a_new_version(self):
        self.assertEqual(self.invoke(), 'version=v1.2.3\n')

    def test_github_failure_is_not_treated_as_permission_to_release(self):
        values = {'GITHUB_REF': 'refs/heads/main', 'RELEASE_VERSION': 'v1.2.3', 'GITHUB_SHA': 'a' * 40}
        with patch.dict(os.environ, values), patch.object(guard, 'api', side_effect=OSError('unavailable')):
            with self.assertRaises(OSError):
                guard.main()


if __name__ == '__main__':
    unittest.main()
