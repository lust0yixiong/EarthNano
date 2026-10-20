"""Test-only transport fixture. Not a production RPC server or CLI entry point."""
import copy
import json
import sys

from harness2.core.execution_contract import ExecutionStopped
from harness2.core.method_execution import PortMethodExecution
from harness2.core.proposer import Proposer, Reply
from harness2.core.spec import ChannelSpec


class RemoteError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def exchange(operation, **arguments):
    print(json.dumps({'operation': operation, **arguments}), flush=True)
    reply = json.loads(sys.stdin.readline())
    if 'error' in reply:
        raise RemoteError(reply['error']['code'], reply['error']['message'])
    return reply['result']


class TestPort:
    def submit(self, request): return exchange('submit', request=request)
    def get(self, execution_id): return exchange('get', executionId=execution_id)
    def cancel(self, execution_id): return exchange('cancel', executionId=execution_id)
    def events(self, execution_id, after_sequence=0):
        return iter(exchange('events', executionId=execution_id, afterSequence=after_sequence))


fixture = json.load(open('contracts/execution/fixtures.json'))['valid']


def request_factory(invocation):
    request = copy.deepcopy(fixture)
    request.update(requestKey=invocation.label, role=invocation.role,
                   origin={'kind': 'optimization', 'optimizationId': 'cross-language',
                           'stageId': invocation.stage_label}, interactionPolicy='deny-unresolved')
    request['invocationRef']['id'] = invocation.label
    return request


class Reader:
    def reply(self, record, invocation):
        return Reply(label=invocation.label, text=record['evidence']['text'], ok=True)
    def rollout(self, record, invocation):
        raise AssertionError('This fixture tests the improver path only')


execution = PortMethodExecution(TestPort(), request_factory, Reader())
proposer = Proposer(ChannelSpec('opencode', 'test/model'))
reply = execution.call(proposer, 'mission', None, 'inv1.a1', role='proposer',
                       task_id='t1', scope='smoke', stage_label='inv1', max_attempts=1)
stopped = False
try:
    execution.call(proposer, 'mission', None, 'inv2.a1', role='proposer',
                   task_id='t1', scope='smoke', stage_label='inv2', max_attempts=1)
except ExecutionStopped:
    stopped = True
exchange('done', text=reply.text, stopped=stopped)
