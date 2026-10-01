import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import auth
import launcher

CLIENT = '11111111-2222-3333-4444-555555555555'
ACCOUNT = {'name': 'RealPlayer', 'uuid': 'a' * 32, 'access_token': 'mc-secret', 'refresh_token': 'refresh-secret', 'expires_at': 0, 'client_id': CLIENT, 'xuid': '123'}

class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_cache_private_and_logout(self):
        auth.save(self.root, ACCOUNT)
        path = auth.account_path(self.root)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(auth.account_info(self.root), {'name': 'RealPlayer', 'uuid': 'a'*32})
        auth.logout(self.root)
        self.assertFalse(path.exists())

    def test_refresh_rotates_and_persists_tokens(self):
        auth.save(self.root, ACCOUNT)
        fresh = {**ACCOUNT, 'access_token': 'new-mc', 'refresh_token': 'new-refresh', 'expires_at': time.time()+5000}
        with patch.object(auth, 'request', return_value={'access_token': 'new-ms', 'refresh_token': 'new-refresh'}) as request, patch.object(auth, 'exchange', return_value=fresh) as exchange:
            self.assertEqual(auth.session(self.root)['access_token'], 'new-mc')
            self.assertEqual(request.call_args.args[1]['grant_type'], 'refresh_token')
            self.assertEqual(exchange.call_args.args[0]['refresh_token'], 'new-refresh')
        self.assertEqual(auth.load(self.root)['refresh_token'], 'new-refresh')

    def test_no_client_id_does_not_contact_provider(self):
        with patch.object(auth, 'request') as request, self.assertRaises(auth.AuthError):
            auth.login(self.root, '', lambda *_: None)
        request.assert_not_called()

    def test_exchange_rejects_missing_entitlement(self):
        responses = [{'Token':'xbox'}, {'Token':'xsts','DisplayClaims':{'xui':[{'uhs':'hash'}]}}, {'access_token':'mc','expires_in':3600}, {'items':[]}]
        with patch.object(auth, 'request', side_effect=responses), self.assertRaises(auth.AuthError):
            auth.exchange({'access_token':'ms'}, CLIENT)
        self.assertFalse(auth.account_path(self.root).exists())

    def test_online_launch_uses_verified_identity(self):
        folder = self.root / 'versions' / 'test'
        folder.mkdir(parents=True)
        java = self.root / 'java'
        java.touch()
        data = {'mainClass':'Main', 'arguments': {'jvm':[], 'game':['--username','${auth_player_name}','--uuid','${auth_uuid}','--accessToken','${auth_access_token}','--userType','${user_type}']}}
        with patch.object(auth, 'session', return_value=ACCOUNT), patch.object(launcher, 'prepare', return_value=(data, folder, [], folder)):
            cmd, _ = launcher.command(self.root, 'test', 'OfflineName', java, 2, online=True)
        self.assertEqual(cmd[cmd.index('--username')+1], 'RealPlayer')
        self.assertEqual(cmd[cmd.index('--accessToken')+1], 'mc-secret')
        self.assertEqual(cmd[cmd.index('--userType')+1], 'msa')

if __name__ == '__main__':
    unittest.main()
