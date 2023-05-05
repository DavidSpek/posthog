import { PageHeader } from 'lib/components/PageHeader'
import { teamLogic } from 'scenes/teamLogic'
import { useActions, useValues } from 'kea'
import { urls } from 'scenes/urls'
import { SceneExport } from 'scenes/sceneTypes'
import { SessionRecordingsPlaylist } from './playlist/SessionRecordingsPlaylist'
import { LemonBanner } from 'lib/lemon-ui/LemonBanner'
import { LemonButton } from '@posthog/lemon-ui'
import { Tabs } from 'antd'
import { AvailableFeature, SessionRecordingsTabs } from '~/types'
import { SavedSessionRecordingPlaylists } from './saved-playlists/SavedSessionRecordingPlaylists'
import { humanFriendlyTabName, sessionRecordingsLogic } from './sessionRecordingsLogic'
import { Spinner } from 'lib/lemon-ui/Spinner/Spinner'
import { IconSettings } from 'lib/lemon-ui/icons'
import { router } from 'kea-router'
import { openSessionRecordingSettingsDialog } from './settings/SessionRecordingSettings'
import { SessionRecordingFilePlayback } from './file-playback/SessionRecordingFilePlayback'
import { createPlaylist } from './playlist/playlistUtils'
import { useAsyncHandler } from 'lib/hooks/useAsyncHandler'
import { eventUsageLogic } from 'lib/utils/eventUsageLogic'
import { sceneLogic } from 'scenes/sceneLogic'
import { savedSessionRecordingPlaylistsLogic } from './saved-playlists/savedSessionRecordingPlaylistsLogic'

export function SessionsRecordings(): JSX.Element {
    const { currentTeam } = useValues(teamLogic)
    const { tab } = useValues(sessionRecordingsLogic)
    const recordingsDisabled = currentTeam && !currentTeam?.session_recording_opt_in
    const { reportRecordingPlaylistCreated } = useActions(eventUsageLogic)
    const { guardAvailableFeature } = useActions(sceneLogic)
    const playlistsLogic = savedSessionRecordingPlaylistsLogic({ tab: SessionRecordingsTabs.Recent })
    const { playlists } = useValues(playlistsLogic)

    const newPlaylistHandler = useAsyncHandler(async () => {
        await createPlaylist({}, true)
        reportRecordingPlaylistCreated('new')
    })

    return (
        // Margin bottom hacks the fact that our wrapping container has an annoyingly large padding
        <div className="-mb-16">
            <PageHeader
                title={<div>Session Recordings</div>}
                buttons={
                    <>
                        {tab === SessionRecordingsTabs.Recent && !recordingsDisabled && (
                            <LemonButton
                                type="secondary"
                                icon={<IconSettings />}
                                onClick={() => openSessionRecordingSettingsDialog()}
                            >
                                Configure
                            </LemonButton>
                        )}

                        {tab === SessionRecordingsTabs.Playlists && (
                            <LemonButton
                                type="primary"
                                onClick={(e) =>
                                    guardAvailableFeature(
                                        AvailableFeature.RECORDINGS_PLAYLISTS,
                                        'recording playlists',
                                        "Playlists allow you to save certain session recordings as a group to easily find and watch them again in the future. You've unfortunately run out of playlists on your current subscription plan.",
                                        () => newPlaylistHandler.onEvent?.(e),
                                        undefined,
                                        playlists.count
                                    )
                                }
                                data-attr="save-recordings-playlist-button"
                                loading={newPlaylistHandler.loading}
                            >
                                New playlist
                            </LemonButton>
                        )}
                    </>
                }
            />
            <Tabs
                activeKey={tab}
                animated={false}
                style={{ borderColor: '#D9D9D9' }}
                onChange={(t) => router.actions.push(urls.sessionRecordings(t as SessionRecordingsTabs))}
            >
                {Object.values(SessionRecordingsTabs).map((value) => (
                    <Tabs.TabPane tab={humanFriendlyTabName(value)} key={value} />
                ))}
            </Tabs>
            {recordingsDisabled ? (
                <div className="mb-4">
                    <LemonBanner
                        type="info"
                        action={{
                            type: 'secondary',
                            icon: <IconSettings />,
                            onClick: () => openSessionRecordingSettingsDialog(),
                            children: 'Configure',
                        }}
                    >
                        Session recordings are currently disabled for this project.
                    </LemonBanner>
                </div>
            ) : null}
            {!tab ? (
                <Spinner />
            ) : tab === SessionRecordingsTabs.Recent ? (
                <SessionRecordingsPlaylist updateSearchParams />
            ) : tab === SessionRecordingsTabs.Playlists ? (
                <SavedSessionRecordingPlaylists tab={SessionRecordingsTabs.Playlists} />
            ) : tab === SessionRecordingsTabs.FilePlayback ? (
                <SessionRecordingFilePlayback />
            ) : null}
        </div>
    )
}

export const scene: SceneExport = {
    component: SessionsRecordings,
    logic: sessionRecordingsLogic,
}
