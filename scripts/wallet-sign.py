import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import stat
import sys
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
WALLETS = Path(os.environ.get('HEDGE_APP_DIR', str(ROOT/'packages'/'nextjs'))) / '.hedge' / 'wallets.json'
CAST = shutil.which('cast')


def read_wallets():
    if WALLETS.parent.is_symlink():
        raise RuntimeError('Refusing symlinked wallet storage.')
    fd = os.open(WALLETS, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16384:
            raise RuntimeError('Wallets must be a private regular file with permissions 0600.')
        with os.fdopen(fd, closefd=False) as source:
            wallets = json.load(source)
        if set(wallets) != {'hedera', 'base'}:
            raise RuntimeError('Expected Hedera and Base wallets.')
        for wallet in wallets.values():
            if set(wallet) != {'address', 'private_key'} or not re.fullmatch(r'0x[0-9a-fA-F]{40}', wallet['address']) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', wallet['private_key']):
                raise RuntimeError('Invalid wallet address or private key.')
        if wallets['hedera']['address'].lower() == wallets['base']['address'].lower():
            raise RuntimeError('Use separate operator and relay wallets.')
        return wallets
    except (ValueError, TypeError, KeyError):
        raise RuntimeError('Invalid .hedge/wallets.json.') from None
    finally:
        os.close(fd)


def wallet_for(network):
    return read_wallets()['hedera' if network == 'hedera-testnet' else 'base']


def with_key(args, private_key):
    child, terminal = pty.fork()
    if child == 0:
        os.execv(CAST, [CAST, *args, '--interactive', '--color', 'never'])
    output = bytearray()
    sent = False
    deadline = time.monotonic() + 45
    status = None
    try:
        while time.monotonic() < deadline:
            if select.select([terminal], [], [], 0.1)[0]:
                try:
                    chunk = os.read(terminal, 8192)
                except OSError:
                    _, status = os.waitpid(child, 0)
                    break
                if not chunk:
                    _, status = os.waitpid(child, 0)
                    break
                output.extend(chunk)
            if not sent and b'private key' in bytes(output).lower():
                if not termios.tcgetattr(terminal)[3] & termios.ECHO:
                    os.write(terminal, private_key.encode() + b'\n')
                    sent = True
            ended, child_status = os.waitpid(child, os.WNOHANG)
            if ended:
                status = child_status
                break
        if status is None:
            ended, child_status = os.waitpid(child, os.WNOHANG)
            if not ended:
                os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)
                raise RuntimeError('Hidden private key prompt timed out.')
            status = child_status
        text = output.decode(errors='replace').replace(private_key, '[redacted]')
        if os.waitstatus_to_exitcode(status) != 0:
            diagnostic = re.sub(r'(?:0x)?[0-9a-fA-F]{64,}', '[redacted]', text)
            raise RuntimeError('Wallet signing operation failed: ' + diagnostic[:1200])
        values = re.findall(r'0x[0-9a-fA-F]+', text)
        if not values:
            raise RuntimeError('No public result returned by the wallet operation.')
        return values[-1]
    finally:
        os.close(terminal)


