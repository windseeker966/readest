import sys, yaml
src, dst, ent = sys.argv[1:4]
d = yaml.safe_load(open(src))
d['settingGroups']['app']['base'].update(PRODUCT_BUNDLE_IDENTIFIER='com.wind.readest', DEVELOPMENT_TEAM='786287C4WM')
t = d['targets']['Readest_iOS']
t['settings']['base']['CODE_SIGN_ENTITLEMENTS'] = ent
t['dependencies'] = [x for x in t['dependencies'] if x.get('target') not in ('ShareExtension', 'ReadestWidget')]
for k in ('ShareExtension', 'ReadestWidget'):
    del d['targets'][k]
yaml.safe_dump(d, open(dst, 'w'), sort_keys=False, allow_unicode=True)
d = yaml.safe_load(open(dst))
for s in d['targets']['Readest_iOS']['sources']:
    if s['path'] in ('Externals', 'assets', 'LaunchScreen.storyboard'):
        s['optional'] = True
yaml.safe_dump(d, open(dst, 'w'), sort_keys=False, allow_unicode=True)
