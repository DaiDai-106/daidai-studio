"""运行场景 Python 测试，并拒绝空测试集或全部跳过。"""

import argparse
import sys
import unittest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start-directory', default='tests/python')
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.discover(args.start_directory)
    if suite.countTestCases() == 0:
        print('没有发现 Python 测试。', file=sys.stderr)
        return 1
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(
        f'Python 测试：{result.testsRun}，跳过：{len(result.skipped)}，'
        f'失败：{len(result.failures)}，错误：{len(result.errors)}，'
        f'预期失败：{len(result.expectedFailures)}。'
    )
    if result.testsRun == 0 or len(result.skipped) == result.testsRun:
        print('Python 测试未实际执行。', file=sys.stderr)
        return 1
    return 0 if result.wasSuccessful() and not result.expectedFailures else 1


if __name__ == '__main__':
    sys.exit(main())
