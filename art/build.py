from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import json,re,math
P=Path(__file__).parent
palette=set(c.lower() for c in re.findall(r'#[0-9a-fA-F]{6}',Path('SPEC.md').read_text()))
bg='#1c3a52'; cream='#fffaf0'; ink='#3b2a23'
def new(w,h): return Image.new('RGBA',(w,h))
def box(im,b,c): ImageDraw.Draw(im).rectangle(b,fill=c)
def ellipse(im,b,c): ImageDraw.Draw(im).ellipse(b,fill=c)
def line(im,pts,c,width=1): ImageDraw.Draw(im).line(pts,fill=c,width=width)
def eye(im,x,y,c): box(im,(x,y,x+1,y+1),c); box(im,(x,y,x,y),'#ffffff')
def sprite(kind):
 im=new(24,24)
 if kind=='otter':
  ellipse(im,(4,2,9,8),'#5e4331'); ellipse(im,(15,2,20,8),'#5e4331'); ellipse(im,(5,3,8,6),'#9c8163'); ellipse(im,(16,3,19,6),'#9c8163')
  ellipse(im,(6,13,18,23),'#5e4331'); ellipse(im,(7,14,17,22),'#a47d5a'); ellipse(im,(9,16,15,21),'#bf9a76'); ellipse(im,(3,4,21,19),'#5e4331'); ellipse(im,(4,5,20,18),'#9c8163'); ellipse(im,(7,11,17,17),'#f1e3cc'); eye(im,7,9,ink); eye(im,16,9,ink); box(im,(5,12,6,12),'#eda9a4'); box(im,(18,12,19,12),'#eda9a4'); ImageDraw.Draw(im).polygon([(12,11),(10,13),(14,13)],fill=ink); box(im,(12,14,12,15),ink)
 elif kind=='octopus':
  for x in (3,8,13,18): ellipse(im,(x,14,x+3,22),'#56719a'); box(im,(x+1,16,x+2,20),'#86a3c7')
  ellipse(im,(2,2,21,19),'#56719a'); ellipse(im,(3,3,20,18),'#86a3c7'); box(im,(6,5,7,5),'#b4c9e2'); eye(im,7,11,'#27303f'); eye(im,15,11,'#27303f'); box(im,(5,14,6,14),'#f3a8b8'); box(im,(18,14,19,14),'#f3a8b8'); box(im,(11,15,12,15),'#56719a')
 elif kind=='dragon':
  for x,y in [(6,2),(3,8),(7,13),(15,14),(12,20),(2,18)]:
   ImageDraw.Draw(im).polygon([(x,y+3),(x-2,y),(x+2,y),(x+3,y+2)],fill='#4f7232'); line(im,[(x-1,y),(x+1,y+1)],'#b3d77a')
  line(im,[(8,4),(11,9),(9,14),(6,18),(8,21),(12,21)],'#7a5a22',5); line(im,[(8,4),(11,9),(9,14),(6,18),(8,21),(12,21)],'#e3b54e',3)
  ellipse(im,(7,4,16,11),'#7a5a22'); ellipse(im,(8,5,15,10),'#e3b54e'); box(im,(14,8,22,10),'#7a5a22'); box(im,(15,8,21,9),'#e3b54e'); eye(im,12,6,'#7a5a22')
  for y in (12,15,18): line(im,[(7,y),(10,y)],'#f5df98')
 else:
  for x,y in [(11,0),(4,3),(19,3),(1,10),(22,10),(4,19),(19,19),(11,22)]: line(im,[(x,y),(12,12)],'#8a5d1e',2)
  ellipse(im,(3,3,20,21),'#8a5d1e'); ellipse(im,(4,4,19,20),'#f2c766'); ellipse(im,(5,12,18,20),'#fbf3dc'); ImageDraw.Draw(im).polygon([(1,12),(4,10),(4,16)],fill='#eaa64c'); ImageDraw.Draw(im).polygon([(22,12),(19,10),(19,16)],fill='#eaa64c'); eye(im,7,9,'#8a5d1e'); eye(im,15,9,'#8a5d1e'); box(im,(5,12,6,12),'#eda9a4'); box(im,(18,12,19,12),'#eda9a4'); box(im,(11,13,12,13),'#8a5d1e')
 return im
chars={k:sprite(k) for k in ('otter','octopus','dragon','puffer')}
# One canonical character definition, consumed by generation and front end.
(P/'characters.js').write_text('export const characters = '+json.dumps({k:{'width':24,'height':24,'pixels':[[('#%02x%02x%02x'%px[:3]) if px[3] else None for px in list(im.getdata())[y*24:(y+1)*24]] for y in range(24)]} for k,im in chars.items()})+';\n')
suits=[('#e2553f','#9a2f22'),('#f0b14e','#b77a22'),('#7fae6e','#3f6b3a'),('#8a6fc0','#c9b6ee')]
patterns=['.#...#.\n##...##\n.#####.\n#######\n.#####.\n.#...#.\n#.....#','...#...\n...#...\n#######\n.#####.\n..###..\n.##.##.\n.#...#.','..###..\n.#####.\n#######\n.#####.\n#######\n.#...#.\n..#.#..','..###..\n.#####.\n#######\n#######\n.#.#.#.\n.#.#.#.\n..#.#..']
def suit(im,n,x,y):
 for yy,row in enumerate(patterns[n].splitlines()):
  for xx,v in enumerate(row):
   if v=='#': box(im,(x+xx,y+yy,x+xx,y+yy),suits[n][0])
font=ImageFont.truetype(str(P/'DotGothic16-Regular.ttf'),16)
def text(im,xy,s,color=cream,size=16):
 f=ImageFont.truetype(str(P/'DotGothic16-Regular.ttf'),size); mask=Image.new('1',im.size); ImageDraw.Draw(mask).text(xy,s,font=f,fill=1,stroke_width=0,anchor='lt'); im.paste(color,(0,0,im.width,im.height),mask)
def card(n=0,kind='number'):
 im=new(16,22); box(im,(0,0,15,21),suits[n][1]); box(im,(1,1,14,20),cream)
 if kind=='back':
  box(im,(0,0,15,21),'#86a3c7'); box(im,(1,1,14,20),'#b4c9e2')
  box(im,(2,2,13,19),'#d6ebf7'); box(im,(3,3,12,18),'#b4c9e2')
  # Original sea urchin motif; integer pixel spokes around one small body.
  for x,y in [(7,4),(10,5),(13,7),(14,11),(12,15),(10,17),(7,18),(4,17),(2,15),(1,11),(2,7),(4,5)]:
   line(im,[(7,11),(x,y)],'#56719a')
  ellipse(im,(4,8,10,14),'#56719a'); ellipse(im,(5,9,9,13),'#86a3c7')
  box(im,(5,9,6,9),'#d6ebf7'); box(im,(8,11,8,11),'#b4c9e2')
  return im
 suit(im,n,2,2)
 if kind=='number':
  p=['.#####.','##...##','.....##','....##.','...##..','..##...','.##....','##.....','#######']
  for y,row in enumerate(p):
   for x,v in enumerate(row):
    if v=='#': box(im,(4+x,10+y,4+x,10+y),suits[n][0])
 elif kind=='wild':
  box(im,(1,1,14,20),'#3b2a23')
  for j,(x,y) in enumerate([(1,2),(8,2),(1,12),(8,12)]): suit(im,j,x,y)
 elif kind=='skip': ellipse(im,(3,10,12,19),suits[n][0]); ellipse(im,(5,12,10,17),cream); line(im,[(3,19),(12,10)],suits[n][0],2)
 elif kind in ('draw2','draw4'): text(im,(2,8),'+'+('2' if kind=='draw2' else '4'),ink,12)
 elif kind=='reverse':
  for y,flip in [(12,False),(17,True)]:
   line(im,[(3,y),(12,y)],suits[n][0]); line(im,[(3 if flip else 12,y),(5 if flip else 10,y-2)],suits[n][0]); line(im,[(3 if flip else 12,y),(5 if flip else 10,y+2)],suits[n][0])
 elif kind=='swap': ellipse(im,(3,10,12,19),'#a9cce2'); box(im,(6,12,10,17),'#e2553f'); box(im,(7,13,9,16),cream)
 elif kind=='peek': ellipse(im,(2,12,13,18),'#f2b84b'); eye(im,10,13,ink); line(im,[(8,12),(8,9),(11,9)],'#fff1b8'); box(im,(11,8,12,9),'#fff1b8')
 return im
sheet=Image.new('RGBA',(480,270),bg)
for y in range(6,270,19):
 for x in range((y%3)*9,480,31): line(sheet,[(x,y),(x+3,y+1),(x+6,y)],'#244967')
text(sheet,(12,5),'深海　サンプル',cream)
for i,im in enumerate(chars.values()): sheet.alpha_composite(im,(20+i*40,32))
for i,name in enumerate(['ラッコ','タコ','リーフ','フグ']): text(sheet,(13+i*40,59),name,'#c9bc8a',12)
for i in range(4): sheet.alpha_composite(card(i),(20+i*26,84))
for i,k in enumerate(['skip','reverse','draw2','wild','draw4','swap','peek','back']): sheet.alpha_composite(card(i%4,k),(140+i*26,84))
text(sheet,(17,111),'数字',cream,12); text(sheet,(140,111),'スキップ・リバース・＋２・色　／　おたすけ・裏',cream,12)
shell=new(160,90); d=ImageDraw.Draw(shell)
points=[(80,87),(11,67),(2,47),(6,31),(21,28),(23,16),(40,19),(48,5),(63,12),(79,0),(94,12),(111,5),(120,19),(138,16),(140,28),(154,31),(159,47),(150,67)]
d.polygon(points,fill='#d9877a'); inner=[(80,83)]+[(round(80+(x-80)*.96),y+2) for x,y in points[1:]]; d.polygon(inner,fill='#f6b3a8')
for x,y in [(10,34),(26,21),(48,10),(78,5),(109,10),(135,21),(150,35)]: line(shell,[(80,81),(x,y)],'#d9877a',2); line(shell,[(83,80),(x+3,y)],'#fbe0da')
d.polygon([(11,68),(148,68),(139,78),(120,85),(80,89),(40,85),(21,78)],fill='#f3ead8'); line(shell,[(24,78),(80,86),(136,78)],'#c9b48e',2); ellipse(shell,(70,44,90,62),'#f7d9e6'); ellipse(shell,(73,46,85,56),cream)
sheet.alpha_composite(shell,(18,150))
# Three effects: ink with four falling cards, paired bubble swap, anonymous angler flash.
effects={}
im=new(72,64); im.alpha_composite(chars['octopus'],(0,36)); line(im,[(20,45),(30,27),(48,14)],'#27303f',4)
for x,y,r in [(42,8,15),(51,12,17),(36,18,13)]: ellipse(im,(x-r//2,y-r//2,x+r//2,y+r//2),'#27303f')
for i in range(4): im.alpha_composite(card(i,'back'),(8+i*15,32+(i%2)*5))
effects['ink']=im
im=new(72,64)
for x,y,n in [(3,6,0),(38,29,2)]: ellipse(im,(x,y,x+28,y+30),'#a9cce2'); ellipse(im,(x+1,y+1,x+27,y+29),bg); im.alpha_composite(card(n),(x+7,y+5)); box(im,(x+5,y+4,x+7,y+4),'#d6ebf7')
line(im,[(30,18),(35,18),(33,16)],'#d6ebf7'); effects['swap']=im
im=new(72,64); ellipse(im,(17,23,53,44),'#f2b84b'); ImageDraw.Draw(im).polygon([(17,31),(8,23),(8,44)],fill='#e3b54e'); line(im,[(39,24),(38,14),(48,10),(54,15)],'#e3b54e',2); ellipse(im,(51,12,59,20),'#fff1b8'); eye(im,44,29,ink)
for pts in [[(61,8),(64,5)],[(64,16),(69,16)],[(60,23),(63,26)]]: line(im,pts,'#fff1b8')
effects['peek']=im
for i,(name,im) in enumerate(effects.items()): sheet.alpha_composite(im,(205+i*88,159)); text(sheet,(205+i*88,229),['すみ ＋４','いれかえ','のぞきみ'][i],cream,12)
for k,im in chars.items(): im.save(P/(k+'.png'))
for i in range(4): card(i).save(P/('card-number-'+str(i)+'.png'))
for i,k in enumerate(['skip','reverse','draw2','wild','draw4','swap','peek','back']): card(i%4,k).save(P/('card-'+k+'.png'))
for k,im in effects.items(): im.save(P/('effect-'+k+'.png'))
shell.save(P/'shell.png')
sheet.convert('RGB').save(P/'sample-logical.png'); sheet.resize((1920,1080),Image.Resampling.NEAREST).convert('RGB').save(P/'sample.png')
used={'#%02x%02x%02x'%rgb for rgb in sheet.convert('RGB').getdata()}; unknown=used-palette
print('Sample 480x270 -> 1920x1080 (4x), avatars 24x24, cards 16x22, shell 160x90')
print('Palette used:',len(used),'outside SPEC:',sorted(unknown)); assert not unknown
