import React from 'react';
import {createRoot} from 'react-dom/client';
import {App as AntApp,ConfigProvider} from 'antd';
import AiBillingPanel from '../src/AiBillingPanel.jsx';
import '../src/styles.css';

createRoot(document.getElementById('root')).render(<ConfigProvider autoInsertSpaceInButton={false}><AntApp><main style={{padding:16,maxWidth:1280,margin:'auto'}}><AiBillingPanel management={!new URLSearchParams(location.search).has('readonly')}/></main></AntApp></ConfigProvider>);
