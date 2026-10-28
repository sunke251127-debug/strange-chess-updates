"""Export an immutable, completed training snapshot; never reads the active run.

Run from the parent training workspace. Export-only packages can be installed
under android/.local/export-python without changing the training environment.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

MOBILE = Path(__file__).resolve().parents[1]
PROJECT = MOBILE.parent
sys.path.insert(0, str(MOBILE / 'android/.local/export-python'))
sys.path.insert(0, str(PROJECT))

import numpy as np
import torch
from training.az.model import AlphaZeroNet, load_model_weights
from training.az.rewards import return_scale, process_weight
from training.env import encode_observation


class CompleteInference(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, observations):
        features = self.model.tower(self.model.stem(observations))
        return (self.model.policy(features), self.model.value(features),
                self.model.process_value(features))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', type=Path, default=PROJECT / 'training/runs/dashboard-train-20261028-120845-2ac09955/snapshots/candidate-000050.pt')
    args = parser.parse_args()
    snapshot = args.snapshot.resolve()
    job = json.loads((snapshot.parent.parent / 'dashboard.json').read_text(encoding='utf-8'))
    if job['status'] != 'completed':
        raise ValueError('Only a previously completed training run may be deployed')
    before = digest(snapshot)
    state = torch.load(snapshot, map_location='cpu', weights_only=True)
    if state.get('kind') != 'actor_snapshot' or state['iteration'] != job['iteration']:
        raise ValueError('Use the completed run\'s immutable final candidate snapshot')
    torch.set_num_threads(2)
    model = AlphaZeroNet(**state['architecture']).eval()
    load_model_weights(model, state['candidate'])
    network = CompleteInference(model).eval()
    output = MOBILE / 'assets/ai'
    output.mkdir(parents=True, exist_ok=True)
    model_path = output / 'model.onnx'
    torch.onnx.export(network, torch.zeros(1, 44, 10, 9), str(model_path),
                      input_names=['observations'],
                      output_names=['policy', 'value', 'process_value'],
                      dynamic_axes={name: {0: 'batch'} for name in ('observations', 'policy', 'value', 'process_value')},
                      opset_version=17, dynamo=False, external_data=False)
    import onnx
    onnx.checker.check_model(onnx.load(model_path))
    config = dict(state['config'])
    config['reward_scale'] = config.get('reward_scale') or return_scale(config['capture_rewards'], config['max_plies'], config.get('value_objective', 0))
    config['process_weight'] = process_weight(config['capture_rewards'], config['max_plies'], config.get('value_objective', 0))
    metadata = dict(format=1, id='saved-20261028-120845-round50',
                    label='历史模型 · 第50轮', source_run=snapshot.parent.parent.name,
                    source_snapshot=snapshot.name, source_status=job['status'],
                    source_sha256=before, iteration=state['iteration'], actor='candidate',
                    architecture=state['architecture'],
                    parameters=sum(p.numel() for p in model.parameters()),
                    input_shape=[44, 10, 9], outputs=['policy', 'value', 'process_value'],
                    precision='float32', model_file='model.onnx', bytes=model_path.stat().st_size,
                    sha256=digest(model_path), training_config=config,
                    search=dict(simulations=1024, max_depth=64, inference_batch_size=8,
                                c_puct=1.5, noise=False, temperature=0))
    (output / 'model.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Deterministic real-game observations for cross-runtime numerical checks.
    from training.env import ChessEnv
    observations = []
    with ChessEnv() as env:
        env.reset(20261028)
        for step in range(5):
            observations.append(env.observation)
            if step < 4:
                env.step(env.actions[(step * 7) % len(env.actions)])
    encoded = np.stack([encode_observation(obs) for obs in observations])
    with torch.no_grad():
        expected = network(torch.from_numpy(encoded))
    fixtures = dict(observations=observations, policy=expected[0].numpy().tolist(),
                    value=expected[1].numpy().tolist(), process_value=expected[2].numpy().tolist())
    fixtures_dir = MOBILE / 'android/.local/offline-verification'
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    (fixtures_dir / 'pytorch-reference.json').write_text(json.dumps(fixtures), encoding='utf-8')
    public_fixtures = MOBILE / 'tests/fixtures'
    public_fixtures.mkdir(parents=True, exist_ok=True)
    (public_fixtures / 'offline-model-reference.json').write_text(json.dumps(fixtures), encoding='utf-8')
    if digest(snapshot) != before:
        raise RuntimeError('Source snapshot changed during export')
    print(json.dumps(metadata, ensure_ascii=True))


if __name__ == '__main__':
    main()
