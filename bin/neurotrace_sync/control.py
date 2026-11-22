"""Bounded sync barriers and delivery state for agents and UI."""
import json
import time


class SyncControl:
    def sync_status(self, thought_id=None, cutoff=None):
        result = self._sync_basic_status()
        result.update(pending_operations=0, recovered_drafts=0, server_confirmed=False,
                      caught_up=False, checkpoint=None, delivery=None)
        if not self.conn or not result.get('project_id'):
            return result
        where, values = "1=1", []
        if thought_id:
            where += " AND record=?"
            values.append(thought_id)
        if cutoff is not None:
            where += " AND seq<=?"
            values.append(cutoff)
        rows = self.conn.execute("SELECT state,COUNT(*),MAX(server_seq) FROM sync_outbox WHERE " + where + " GROUP BY state", values).fetchall()
        counts = {row[0]: row[1] for row in rows}
        result['pending_operations'] = counts.get('pending', 0)
        result['recovered_drafts'] = counts.get('recovered', 0)
        result['unaccepted_operations'] = [dict(row) for row in self.conn.execute(
            "SELECT op_id,record AS thought_id,error FROM sync_outbox WHERE state='recovered' AND " + where + " ORDER BY seq DESC LIMIT 20", values)]
        result['server_confirmed'] = not result['pending_operations'] and not result['recovered_drafts']
        worker = getattr(self, 'sync_worker', None)
        checkpoint = worker.checkpoint if worker else None
        cursor = self.conn.execute('SELECT cursor FROM sync_binding').fetchone()[0]
        result['local_cursor'] = cursor
        result['checkpoint'] = checkpoint
        result['caught_up'] = bool(checkpoint and cursor >= checkpoint['head'])
        result['synced'] = bool(result['state'] == 'live' and result['server_confirmed'] and result['caught_up'])
        if thought_id:
            canonical = self.conn.execute('SELECT payload,seq FROM sync_canonical WHERE id=?', (thought_id,)).fetchone()
            seq = max([row[2] or 0 for row in rows] + [canonical[1] if canonical else 0])
            peers = [peer for peer in (checkpoint or {}).get('peers', []) if seq > 0 and peer['cursor'] >= seq]
            exists = canonical or self.conn.execute('SELECT 1 FROM thoughts WHERE id=?', (thought_id,)).fetchone()
            state = ('pending' if result['pending_operations'] else 'needs_attention' if result['recovered_drafts'] else
                     'received_by_peers' if peers else 'server_confirmed' if canonical else 'local_only' if exists else 'not_found')
            result['delivery'] = {'thought_id': thought_id, 'state': state, 'server_seq': seq,
                                  'received_by_devices': len(peers), 'peers': peers,
                                  'meaning': 'Devices reported applying this event; this is not a human read receipt.'}
            if state == 'not_found':
                result['server_confirmed'] = result['synced'] = False
        return result

    def get_thought(self, thought_id):
        self.guard_repository()
        if not isinstance(thought_id, str) or not 0 < len(thought_id) <= 100:
            raise ValueError('Provide a valid thought_id')
        if self.conn is None:
            return self._connection_error_result()
        row = self.conn.execute('SELECT * FROM thoughts WHERE id=?', (thought_id,)).fetchone()
        thought = self._strip_embedding_from_row(row) if row else None
        return {'thought': thought, 'base_text': thought['text'] if thought else None,
                'found': thought is not None, 'sync': self.sync_status(thought_id)}

    def sync_control(self, action='status', thought_id=None, timeout_ms=10000, wait_for_peers=0):
        if action not in ('status', 'wait', 'retry'):
            raise ValueError('Choose status, wait or retry')
        if type(timeout_ms) is not int or not 0 <= timeout_ms <= 30000:
            raise ValueError('timeout_ms must be between 0 and 30000')
        if type(wait_for_peers) is not int or not 0 <= wait_for_peers <= 100:
            raise ValueError('wait_for_peers must be between 0 and 100')
        if thought_id is not None and (not isinstance(thought_id, str) or not 0 < len(thought_id) <= 100):
            raise ValueError('Provide a valid thought_id')
        with self.command_lock:
            result = self.sync_status(thought_id)
            if action == 'status':
                return result
            if thought_id and (result.get('delivery') or {}).get('state') == 'not_found':
                return {**result, 'success': False, 'reason': 'memory_not_found'}
            if not result.get('project_id') or not result.get('enabled') or self.conn is None:
                return {**result, 'success': False, 'reason': result['state'], 'retry_scheduled': False}
            try:
                self.guard_repository()
            except ValueError:
                return {**result, 'success': False, 'reason': 'repository_mismatch', 'retry_scheduled': False}
            self.sync_start()
            worker = self.sync_worker
            worker.wake_event.set()
            if action == 'retry':
                return {**result, 'retry_scheduled': True}
            query, args = 'SELECT COALESCE(MAX(seq),0) FROM sync_outbox', []
            if thought_id:
                query += ' WHERE record=?'
                args.append(thought_id)
            cutoff = self.conn.execute(query, args).fetchone()[0]
            generation = worker.checkpoint_generation
        deadline, target = time.monotonic() + timeout_ms / 1000, None
        while True:
            with self.command_lock:
                if self.sync_worker is not worker:
                    return {**self.sync_status(thought_id), 'success': False, 'reason': 'sync_session_changed'}
                result = self.sync_status(thought_id, cutoff)
                if result['state'] in ('access_denied', 'incompatible_server', 'error', 'repository_mismatch'):
                    return {**result, 'success': False, 'reason': result['state']}
                if result['recovered_drafts']:
                    return {**result, 'success': False, 'reason': 'unaccepted_drafts'}
                checkpoint = result.get('checkpoint')
                if result['server_confirmed'] and checkpoint and worker.checkpoint_generation > generation:
                    if target is None:
                        own = self.conn.execute('SELECT COALESCE(MAX(server_seq),0) FROM sync_outbox WHERE seq<=?', (cutoff,)).fetchone()[0]
                        target = max(checkpoint['head'], own)
                    peers = [p for p in checkpoint['peers'] if p['cursor'] >= target]
                    if result['local_cursor'] >= target and len(peers) >= wait_for_peers:
                        return {**result, 'success': True, 'target_confirmed': True, 'synced_through': target,
                                'received_by_devices': len(peers), 'timed_out': False}
            if time.monotonic() >= deadline:
                return {**result, 'success': False, 'reason': 'timeout', 'timed_out': True, 'synced_through': target}
            worker.wake_event.set()
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
