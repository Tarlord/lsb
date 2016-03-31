from urllib2 import urlopen
from urllib import urlencode
from json import loads
from subprocess import Popen
from pprint import pprint
import click

# TODO: process error with twitch api
# TODO: check somehow if livestreamer is available
# TODO: think about stream info output!
# TODO: Add search
# TODO: Make multi-resolution display
# TODO: Random stream select feature

@click.command()
@click.option('-g', '--game', default='', help='Load streams for specific game')
@click.option('-l', '--limit', type=click.IntRange(1,100), default=10, help='Number of streams to load')
@click.option('-t', '--top', is_flag=True, help='Open top stream right away')
@click.option('-q', '--quality', type=click.Choice(['worst', 'low', 'high', 'medium', 'high', 'source', 'best']), default='high', help='Stream quality')
def main(game, limit, top, quality):
    params = urlencode({'limit': limit, 'game': game})
    streams = loads(urlopen("https://api.twitch.tv/kraken/streams?{}".format(params)).read())["streams"]
    if top:
        streamNum = 1
    else:
        click.echo("Top twitch.tv streams right now:")
        click.echo("\n".join(map(makeStreamInfoString, enumerate(streams))))
        # click.confirm('Want to watch something?', abort=True)
        streamNum = click.prompt('Type stream number to start livestreamer', type=click.IntRange(1, len(streams)))
    Popen(['livestreamer', streams[int(streamNum) - 1]["channel"]["url"], quality])

def makeStreamInfoString(streamEnum):
    (i, stream) = streamEnum
    pprint(stream["channel"])
    channelName = stream["channel"]["name"] or "?" * 8
    channelStatus = stream["channel"]["status"] or "?" * 8
    game = stream["game"] or "?" * 8
    viewers = str(stream["viewers"])
    return u"[{:02d}] {:-^30} {:+^20} {: ^40} {}".format(
        i + 1,
        click.style(channelName, bold=True),
        click.style(viewers, bold=True),
        click.style(game, bold=True),
        channelStatus

    )

if __name__ == '__main__':
    main()
